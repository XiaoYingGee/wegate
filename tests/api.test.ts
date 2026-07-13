import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { startApiServer, type ApiServerDeps } from "../src/api.js";
import { SessionStore } from "../src/store/session.js";
import { Router } from "../src/router.js";
import type { ILinkClient } from "../src/client/ilink.js";

interface SendCall {
  to: string;
  text: string;
  token: string;
}

function makeClient(sendCalls: SendCall[], shouldFail = false): ILinkClient {
  return {
    sendText: async (to: string, text: string, token: string) => {
      if (shouldFail) throw new Error("upstream failure");
      sendCalls.push({ to, text, token });
    },
  } as unknown as ILinkClient;
}

async function withServer(
  overrides: Partial<ApiServerDeps> & { onDir?: (dir: string) => void } = {},
  fn: (baseUrl: string, ctx: { store: SessionStore; sendCalls: SendCall[] }) => Promise<void>,
) {
  const dir = await mkdtemp(resolve(tmpdir(), "wegate-api-test-"));
  const store = overrides.store ?? new SessionStore(resolve(dir, "session.json"));
  const router = overrides.router ?? new Router();
  const sendCalls: SendCall[] = [];
  const client = overrides.client ?? makeClient(sendCalls);

  const server = startApiServer(
    { client, store, router, apiToken: overrides.apiToken },
    "127.0.0.1",
    0,
  );

  await new Promise<void>((res) => server.once("listening", () => res()));
  const port = (server.address() as AddressInfo).port;

  try {
    await fn(`http://127.0.0.1:${port}`, { store, sendCalls });
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    await rm(dir, { recursive: true, force: true });
  }
}

describe("API auth (BUG-6)", () => {
  it("allows unauthenticated access to /api/status when no token is configured", async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/status`);
      expect(res.status).toBe(200);
    });
  });

  it("rejects /api/status without an Authorization header when token is configured", async () => {
    await withServer({ apiToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/status`);
      expect(res.status).toBe(401);
    });
  });

  it("rejects /api/status with a wrong token", async () => {
    await withServer({ apiToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });
  });

  it("accepts /api/status with the correct bearer token", async () => {
    await withServer({ apiToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });
  });

  it("rejects /api/send without a token when configured", async () => {
    await withServer({ apiToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "hi" }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("accepts /api/send with the correct bearer token", async () => {
    await withServer({ apiToken: "secret" }, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "tok1");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({ to: "peer1", text: "hi" }),
      });
      expect(res.status).toBe(200);
    });
  });
});

describe("BUG-4: /api/send logs success and failure", () => {
  it("logs a success line including peer and truncated text", async () => {
    await withServer({}, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "tok1");
      const spy = vi.spyOn(console, "log");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "hello world" }),
      });
      expect(res.status).toBe(200);
      const logged = spy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("/api/send") && a.includes("peer1")),
      );
      expect(logged).toBe(true);
      spy.mockRestore();
    });
  });

  it("logs a failure line when the client throws", async () => {
    const sendCalls: SendCall[] = [];
    const client = makeClient(sendCalls, true);
    await withServer({ client }, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "tok1");
      const spy = vi.spyOn(console, "error");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "hello world" }),
      });
      expect(res.status).toBe(502);
      const logged = spy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("/api/send") && a.includes("peer1")),
      );
      expect(logged).toBe(true);
      spy.mockRestore();
    });
  });
});

describe("BUG-14: /api/send 'to' fallback uses most-recent peer, not currentPeer", () => {
  it("falls back to the most recently active peer (listPeers()[0]), not the first-ever peer", async () => {
    await withServer({}, async (baseUrl, { store, sendCalls }) => {
      store.upsertPeer("peerA", "tokA");
      await new Promise((r) => setTimeout(r, 10));
      store.upsertPeer("peerB", "tokB");

      // currentPeer is still "peerA" (first-ever contact, never updated)
      expect(store.currentPeer).toBe("peerA");

      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "no 'to' provided" }),
      });

      expect(res.status).toBe(200);
      expect(sendCalls[0]?.to).toBe("peerB");
    });
  });

  it("returns 400 with a clear error when there are no known peers at all", async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "no peers yet" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no known peer/i);
    });
  });
});
