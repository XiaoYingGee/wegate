import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { startApiServer, type ApiServerDeps } from "../src/api.js";
import { SessionStore } from "../src/store/session.js";
import { MAX_OUTBOX_MESSAGES } from "../src/store/session.js";
import { Router } from "../src/router.js";
import { ILinkSendError, type ILinkClient } from "../src/client/ilink.js";

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

describe("proactive delivery readiness and durable queue", () => {
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

  it("fast-fails a token older than 24 hours into the persistent outbox", async () => {
    await withServer({}, async (baseUrl, { store, sendCalls }) => {
      store.upsertPeer("peer1", "stale-token");
      store.session.peers.peer1.context_token_updated_at = "2026-08-14T00:00:00.000Z";

      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "morning reminder" }),
      });
      const body = await res.json();

      expect(res.status).toBe(202);
      expect(body).toMatchObject({
        delivered: false,
        queued: true,
        reason: "stale_context",
        to: "peer1",
      });
      expect(body.action).toMatch(/send any message/i);
      expect(sendCalls).toEqual([]);
      expect(store.listPendingOutbox("peer1")).toEqual([
        expect.objectContaining({ text: "morning reminder" }),
      ]);
    });
  });

  it("queues ret=-2 prepare failed and marks subsequent sends not ready", async () => {
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

      expect(res.status).toBe(202);
      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: false,
        reason: "context_rejected",
      });
      expect(store.listPendingOutbox("peer1")).toHaveLength(1);

      const second = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "second reminder" }),
      });
      expect(second.status).toBe(202);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(store.listPendingOutbox("peer1")).toHaveLength(2);
    });
  });

  it("retries once with a newer context when inbound refresh wins an in-flight race", async () => {
    let rejectOld!: (error: unknown) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const oldRequest = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const sendText = vi
      .fn()
      .mockImplementationOnce(async () => {
        signalStarted();
        return oldRequest;
      })
      .mockResolvedValueOnce(undefined);
    const client = { sendText } as unknown as ILinkClient;

    await withServer({ client }, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "context-1");
      const request = fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "racing reminder" }),
      });

      await started;
      store.upsertPeer("peer1", "context-2");
      rejectOld(new ILinkSendError(-2, "prepare failed"));
      const res = await request;
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        delivered: true,
        queued: false,
        retried_after_inbound_refresh: true,
      });
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText.mock.calls[0]?.[2]).toBe("context-1");
      expect(sendText.mock.calls[1]?.[2]).toBe("context-2");
      expect(store.getPeerOutboundStatus("peer1").ready).toBe(true);
      expect(store.listPendingOutbox("peer1")).toEqual([]);
    });
  });

  it("reports connectivity separately from default-peer and total outbound readiness", async () => {
    await withServer({}, async (baseUrl, { store }) => {
      store.setLogin("bot-token", "bot1", "user1", "https://example.com");
      store.upsertPeer("older", "stale-token");
      store.session.peers.older.context_token_updated_at = "2026-08-14T00:00:00.000Z";
      store.enqueueOutbox("older", "old queued message");
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.upsertPeer("latest", "fresh-token");
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
          pending_for_peer: 1,
          pending_total: 2,
          action: null,
        },
      });
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

  it("returns 507 without losing the request contract when the outbox is full", async () => {
    await withServer({}, async (baseUrl, { store }) => {
      store.upsertPeer("peer1", "stale-token");
      store.session.peers.peer1.context_token_updated_at = "2026-08-14T00:00:00.000Z";
      for (let i = 0; i < MAX_OUTBOX_MESSAGES; i += 1) {
        store.enqueueOutbox("peer1", `queued-${i}`);
      }

      const res = await fetch(`${baseUrl}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "peer1", text: "cannot be queued" }),
      });

      expect(res.status).toBe(507);
      await expect(res.json()).resolves.toMatchObject({
        code: "outbox_capacity_exceeded",
      });
      expect(store.listPendingOutbox()).toHaveLength(MAX_OUTBOX_MESSAGES);
    });
  });
});
