import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ILinkClient } from "./client/ilink.js";
import type { SessionStore } from "./store/session.js";
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

  jsonResponse(res, 200, {
    status: store.isLoggedIn ? "connected" : "disconnected",
    bot_id: store.session.bot_id,
    peers: peers.length,
    processors: router.listProcessors(),
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
  let to = data.to?.trim();
  if (!to) {
    to = store.listPeers()[0];
  }
  if (!to) {
    logError(`/api/send 失败: 未提供 'to' 且没有任何联系人 — 消息摘要: "${summary}"`);
    return jsonResponse(res, 400, {
      error: "missing 'to' field and no known peer (nobody has messaged the bot yet)",
    });
  }

  const token = store.getPeerToken(to);
  if (!token) {
    logError(`/api/send 失败: peer '${to}' 没有 context_token — 消息摘要: "${summary}"`);
    return jsonResponse(res, 400, {
      error: `no context_token for peer '${to}', they must message you first`,
    });
  }

  try {
    await client.sendText(to, text, token);
    log(`/api/send 成功 → [${to}]: "${summary}"`);
    jsonResponse(res, 200, { ok: true, to, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`/api/send 失败 → [${to}]: "${summary}" — ${msg}`);
    jsonResponse(res, 502, { error: `send failed: ${msg}` });
  }
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
