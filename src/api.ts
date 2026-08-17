import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ILinkClient } from "./client/ilink.js";
import { isContextUnavailableError } from "./client/ilink.js";
import type { SessionStore } from "./store/session.js";
import { OutboxCapacityError } from "./store/session.js";
import type { Router } from "./router.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[wegate] ${msg}`, ...args);
const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

export interface ApiServerDeps {
  client: ILinkClient;
  store: SessionStore;
  router: Router;
  /** Optional shared secret required via `Authorization: Bearer <token>`. */
  apiToken?: string;
  /** Optional peers permitted to drive processors and receive pushed messages. */
  allowedSenders?: string[];
}

export function startApiServer(
  deps: ApiServerDeps,
  host: string,
  port: number,
): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, deps);
    } catch (err) {
      console.error("[api] unhandled error:", err);
      jsonResponse(res, 500, { error: "internal server error" });
    }
  });

  server.listen(port, host, () => {
    console.log(`[wegate] API server listening on http://${host}:${port}`);
  });

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path === "/api/status" && req.method === "GET") {
    if (!isAuthorized(req, deps.apiToken)) {
      logError(`/api/status 鉴权失败，拒绝请求`);
      return jsonResponse(res, 401, { error: "unauthorized" });
    }
    return handleStatus(res, deps);
  }

  if (path === "/api/send" && req.method === "POST") {
    if (!isAuthorized(req, deps.apiToken)) {
      logError(`/api/send 鉴权失败，拒绝请求`);
      return jsonResponse(res, 401, { error: "unauthorized" });
    }
    return handleSend(req, res, deps);
  }

  jsonResponse(res, 404, { error: "not found" });
}

/**
 * When `apiToken` is unset (WEGATE_API_TOKEN not configured), every request
 * is authorized — preserving the pre-existing no-auth behavior. Otherwise
 * the request must carry a matching `Authorization: Bearer <token>` header.
 */
function isAuthorized(req: IncomingMessage, apiToken: string | undefined): boolean {
  if (!apiToken) return true;

  const header = req.headers.authorization;
  if (!header) return false;

  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;

  return safeEqual(match[1], apiToken);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function handleStatus(res: ServerResponse, deps: ApiServerDeps) {
  const { store, router } = deps;
  const peers = store.listPeers();

  const peer = peers.find((candidate) => isAllowedPeer(candidate, deps.allowedSenders));
  const readiness = peer ? store.getPeerOutboundStatus(peer) : undefined;
  const outboundReady = store.isLoggedIn && (readiness?.ready ?? false);
  const reason = !store.isLoggedIn
    ? "disconnected"
    : readiness?.reason || (peer ? undefined : "no_known_peer");

  jsonResponse(res, 200, {
    status: store.isLoggedIn ? "connected" : "disconnected",
    connection_basis: "persisted_session",
    bot_id: store.session.bot_id,
    peers: peers.length,
    processors: router.listProcessors(),
    outbound_ready: outboundReady,
    outbound: {
      ready: outboundReady,
      peer: peer || null,
      reason: reason || null,
      token_updated_at: readiness?.tokenUpdatedAt || null,
      expires_at: readiness?.expiresAt || null,
      pending_for_peer: peer ? store.listPendingOutbox(peer).length : 0,
      pending_total: store.listPendingOutbox().length,
      action: outboundReady
        ? null
        : store.isLoggedIn
          ? "Recipient must send any message to the bot to refresh the WeChat reply window."
          : "Wegate has no loaded login session; log in again before attempting delivery.",
    },
  });
}

async function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
) {
  const body = await readBody(req);
  if (!body) {
    return jsonResponse(res, 400, { error: "empty request body" });
  }

  let data: { to?: string; text?: string };
  try {
    data = JSON.parse(body);
  } catch {
    return jsonResponse(res, 400, { error: "invalid JSON" });
  }

  const text = data.text?.trim();
  if (!text) {
    return jsonResponse(res, 400, { error: "missing 'text' field" });
  }

  const { client, store } = deps;
  const summary = text.slice(0, 80) + (text.length > 80 ? "..." : "");

  // Fallback when 'to' is omitted: use the most recently active peer.
  // NOTE: store.currentPeer is NOT "most recent" — it's set once on the
  // first-ever peer and never updated afterwards (see SessionStore.upsertPeer).
  // listPeers() is sorted by last_seen_at descending, so [0] is the real
  // "most recently active" peer.
  const requestedTo = data.to?.trim();
  if (requestedTo && !isAllowedPeer(requestedTo, deps.allowedSenders)) {
    logError(`/api/send 拒绝未授权目标 peer '${requestedTo}' — 消息摘要: "${summary}"`);
    return jsonResponse(res, 403, { error: `peer '${requestedTo}' is not an allowed recipient` });
  }

  let to = requestedTo;
  if (!to) {
    to = store.listPeers().find((candidate) => isAllowedPeer(candidate, deps.allowedSenders));
  }
  if (!to) {
    logError(`/api/send 失败: 未提供 'to' 且没有可用的授权联系人 — 消息摘要: "${summary}"`);
    return jsonResponse(res, 400, {
      error: "missing 'to' field and no known peer allowed for outbound delivery (an allowed recipient must message the bot first)",
    });
  }

  if (!store.hasPeer(to)) {
    logError(`/api/send 失败: 未知 peer '${to}' — 消息摘要: "${summary}"`);
    return jsonResponse(res, 400, {
      error: `unknown peer '${to}', they must message the bot first`,
    });
  }

  const readiness = store.getPeerOutboundStatus(to);
  if (!readiness.ready || !readiness.contextToken) {
    return queueForFreshContext(res, store, to, text, readiness.reason || "stale_context");
  }

  try {
    await client.sendText(to, text, readiness.contextToken);
    log(`/api/send 成功 → [${to}]: "${summary}"`);
    jsonResponse(res, 200, { delivered: true, queued: false, to, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isContextUnavailableError(err)) {
      const rejectedCurrentGeneration = store.markPeerContextRejected(
        to,
        msg,
        readiness.tokenGeneration,
      );

      // A real inbound message may have refreshed the context while the old
      // request was in flight. That is the only legitimate refresh signal, so
      // retry exactly once with the newer generation instead of queueing until
      // yet another inbound message.
      const refreshed = store.getPeerOutboundStatus(to);
      if (
        !rejectedCurrentGeneration &&
        refreshed.ready &&
        refreshed.contextToken &&
        refreshed.tokenGeneration !== readiness.tokenGeneration
      ) {
        try {
          await client.sendText(to, text, refreshed.contextToken);
          log(`/api/send 成功（inbound 刷新后重试）→ [${to}]: "${summary}"`);
          return jsonResponse(res, 200, {
            delivered: true,
            queued: false,
            retried_after_inbound_refresh: true,
            to,
            text,
          });
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (isContextUnavailableError(retryErr)) {
            store.markPeerContextRejected(to, retryMsg, refreshed.tokenGeneration);
            return queueForFreshContext(res, store, to, text, "stale_context", retryMsg);
          }
          logError(`/api/send 刷新后重试失败 → [${to}]: "${summary}" — ${retryMsg}`);
          return jsonResponse(res, 502, { error: `send failed after inbound refresh: ${retryMsg}` });
        }
      }
      return queueForFreshContext(res, store, to, text, "stale_context", msg);
    }
    logError(`/api/send 失败 → [${to}]: "${summary}" — ${msg}`);
    jsonResponse(res, 502, { error: `send failed: ${msg}` });
  }
}

async function queueForFreshContext(
  res: ServerResponse,
  store: SessionStore,
  to: string,
  text: string,
  reason: string,
  upstreamError?: string,
) {
  let entry;
  try {
    entry = store.enqueueOutbox(to, text);
  } catch (err) {
    if (err instanceof OutboxCapacityError) {
      logError(`/api/send 无法排队 → [${to}] — ${err.message}`);
      return jsonResponse(res, 507, {
        error: err.message,
        code: "outbox_capacity_exceeded",
      });
    }
    throw err;
  }
  await store.save();
  log(
    `/api/send 已排队 → [${to}] queue_id=${entry.id} reason=${reason}` +
      (upstreamError ? ` — ${upstreamError}` : ""),
  );
  jsonResponse(res, 202, {
    delivered: false,
    queued: true,
    reason: "stale_context",
    queue_id: entry.id,
    to,
    action: "Recipient must send any message to the bot; Wegate will then retry this queued message.",
  });
}

function isAllowedPeer(peerId: string, allowedSenders: string[] | undefined): boolean {
  return !allowedSenders || allowedSenders.length === 0 || allowedSenders.includes(peerId);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (chunks.reduce((s, c) => s + c.length, 0) > 1_048_576) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
