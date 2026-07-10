import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ILinkClient } from "./client/ilink.js";
import type { SessionStore } from "./store/session.js";
import type { Router } from "./router.js";

export interface ApiServerDeps {
  client: ILinkClient;
  store: SessionStore;
  router: Router;
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
    return handleStatus(res, deps);
  }

  if (path === "/api/send" && req.method === "POST") {
    return handleSend(req, res, deps);
  }

  jsonResponse(res, 404, { error: "not found" });
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

  let to = data.to?.trim();
  if (!to) {
    to = store.currentPeer;
  }
  if (!to) {
    return jsonResponse(res, 400, {
      error: "missing 'to' field and no current peer",
    });
  }

  const token = store.getPeerToken(to);
  if (!token) {
    return jsonResponse(res, 400, {
      error: `no context_token for peer '${to}', they must message you first`,
    });
  }

  try {
    await client.sendText(to, text, token);
    jsonResponse(res, 200, { ok: true, to, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
