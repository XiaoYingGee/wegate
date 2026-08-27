import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { startApiServer, type ApiServerDeps } from "../src/api.js";
import { SessionStore } from "../src/store/session.js";
import { Router } from "../src/router.js";
import {
  ILinkSendError,
  ILinkTimeoutError,
  type ILinkClient,
} from "../src/client/ilink.js";

interface SendCall {
  to: string;
  text: string;
  token?: string;
}

function makeClient(sendCalls: SendCall[], shouldFail = false): ILinkClient {
  return {
    sendText: async (to: string, text: string, token?: string) => {
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
    {
      client,
      store,
      router,
      apiToken: overrides.apiToken,
      allowedSenders: overrides.allowedSenders,
    },
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

describe("proactive delivery and legacy outbox status", () => {
  it("returns 200 only when iLink immediately accepts the message", async () => {
    await withServer({}, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "fresh-token");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "hello" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        delivered: true,
        queued: false,
        to: "peer1",
      });
    });
  });

  it("always attempts delivery with a persisted token regardless of age", async () => {
    await withServer({}, async (baseUrl, { store, sendCalls }) => {
      store.upsertPeer("peer1", "persisted-token");
      store.session.peers.peer1.context_token_updated_at = "2026-08-14T00:00:00.000Z";

      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "morning reminder" }),
      });
      expect(res.status).toBe(200);
      expect(sendCalls).toEqual([
        { to: "peer1", text: "morning reminder", token: "persisted-token" },
      ]);
      expect(store.listPendingOutbox("peer1")).toEqual([]);
    });
  });

  it("returns ret=-2 prepare failed as the real upstream error without queueing", async () => {
    const sendText = vi.fn(async () => {
      throw new ILinkSendError(-2, "prepare failed");
    });
    const client = { sendText } as unknown as ILinkClient;

    await withServer({ client }, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "apparently-fresh-token");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "reminder" }),
      });

      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringMatching(/prepare failed/i),
      });
      expect(store.getPeerOutboundStatus("peer1").ready).toBe(true);
      expect(store.listPendingOutbox("peer1")).toHaveLength(0);

      const second = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "second reminder" }),
      });
      expect(second.status).toBe(502);
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(store.listPendingOutbox("peer1")).toHaveLength(0);
    });
  });

  it("returns a diagnostic 502 when the upstream send times out", async () => {
    const client = {
      sendText: vi.fn(async () => {
        throw new ILinkTimeoutError("/ilink/bot/sendmessage", 15_000);
      }),
    } as unknown as ILinkClient;

    await withServer({ client }, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "persisted-token");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "timeout reminder" }),
      });

      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringMatching(/sendmessage.*timeout after 15000ms/i),
      });
      expect(store.listPendingOutbox()).toEqual([]);
    });
  });

  it("still attempts iLink when a known peer has no captured context token", async () => {
    await withServer({}, async (baseUrl, { store, sendCalls }) => {
      store.upsertPeer("peer1");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "waiting for context" }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        delivered: true,
        queued: false,
      });
      expect(sendCalls).toEqual([
        { to: "peer1", text: "waiting for context", token: undefined },
      ]);
      expect(store.listPendingOutbox("peer1")).toEqual([]);

      const statusRes = await fetch(`${baseUrl}/api/status`);
      const statusBody = await statusRes.json();
      expect(statusBody.outbound).toMatchObject({
        peer: "peer1",
        context_token_available: false,
        token_updated_at: null,
      });
    });
  });

  it("reports connectivity separately from default-peer and total outbound readiness", async () => {
    await withServer({}, async (baseUrl, { store }) => {
      store.setLogin("bot-token", "bot1", "user1", "https://example.com");
      store.upsertPeer("older", "old-token");
      store.session.peers.older.context_token_updated_at = "2026-08-14T00:00:00.000Z";
      store.enqueueOutbox("older", "old queued message");
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.upsertPeer("latest", "fresh-token");
      store.session.peers.latest.context_token_updated_at = "2020-01-01T00:00:00.000Z";
      store.enqueueOutbox("latest", "latest queued message");

      const res = await fetch(`${baseUrl}/api/status`);
      const body = await res.json();

      expect(body).toMatchObject({
        status: "connected",
        outbound_ready: true,
        outbound: {
          ready: true,
          peer: "latest",
          reason: null,
          context_token_available: true,
          token_updated_at: "2020-01-01T00:00:00.000Z",
          pending_for_peer: 1,
          pending_total: 2,
          action: null,
        },
      });
      expect(body.outbound).not.toHaveProperty("expires_at");
    });
  });

  it("ignores a more-recent unauthorized peer when choosing the default target", async () => {
    await withServer({ allowedSenders: ["allowed"] }, async (baseUrl, { store, sendCalls }) => {
      store.upsertPeer("allowed", "allowed-token");
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.upsertPeer("mallory", "mallory-token");

      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "private reminder" }),
      });

      expect(res.status).toBe(200);
      expect(sendCalls).toEqual([
        { to: "allowed", text: "private reminder", token: "allowed-token" },
      ]);
    });
  });

  it("rejects an explicitly targeted peer outside the allowlist", async () => {
    await withServer({ allowedSenders: ["allowed"] }, async (baseUrl, { store, sendCalls }) => {
      store.upsertPeer("mallory", "mallory-token");
      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "mallory", text: "private reminder" }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringMatching(/not an allowed recipient/i),
      });
      expect(sendCalls).toEqual([]);
      expect(store.listPendingOutbox()).toEqual([]);
    });
  });

});
