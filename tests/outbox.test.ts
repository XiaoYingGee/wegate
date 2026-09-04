import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ILinkClient } from "../src/client/ilink.js";
import { flushPendingOutbox } from "../src/outbox.js";
import { SessionStore } from "../src/store/session.js";
import { MAX_OUTBOX_BYTES } from "../src/store/session.js";

async function withStore(fn: (store: SessionStore) => Promise<void>) {
  const dir = await mkdtemp(resolve(tmpdir(), "wegate-outbox-test-"));
  try {
    await fn(new SessionStore(resolve(dir, "session.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("pending outbox recovery", () => {
  it("flushes legacy queued messages FIFO with the stored context token", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "first");
      store.enqueueOutbox("peer1", "second");
      const generation = store.upsertPeer("peer1", "fresh-context");

      const sent: string[] = [];
      const client = {
        sendText: vi.fn(async (_peer: string, text: string) => {
          sent.push(text);
        }),
      } as unknown as ILinkClient;

      const result = await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: generation,
      });

      expect(sent).toEqual(["first", "second"]);
      expect(result).toEqual({ attempted: 2, delivered: 2, remaining: 0 });
      expect(store.listPendingOutbox("peer1")).toEqual([]);
      vi.restoreAllMocks();
    });
  });

  it("does not replay a newly queued fallback failure during startup", async () => {
    await withStore(async (store) => {
      const generation = store.upsertPeer("peer1", "stale-context");
      store.enqueueOutbox("peer1", "wait for a new token", {
        generation,
        error: "tokenless request rejected",
        clientId: "wegate-new-queued-id",
      });
      const sendText = vi.fn(async () => {});

      const result = await flushPendingOutbox(
        { sendText } as unknown as ILinkClient,
        store,
        "peer1",
        { mode: "startup" },
      );

      expect(result).toEqual({ attempted: 0, delivered: 0, remaining: 1 });
      expect(sendText).not.toHaveBeenCalled();
      expect(store.listPendingOutbox("peer1")).toHaveLength(1);

      const refreshedGeneration = store.upsertPeer("peer1", "new-context");
      const refreshed = await flushPendingOutbox(
        { sendText } as unknown as ILinkClient,
        store,
        "peer1",
        { mode: "inbound", attemptGeneration: refreshedGeneration },
      );

      expect(refreshed).toEqual({ attempted: 1, delivered: 1, remaining: 0 });
      expect(sendText).toHaveBeenCalledWith(
        "peer1",
        "wait for a new token",
        "new-context",
        "wegate-new-queued-id",
      );
    });
  });

  it("serializes concurrent flushes so a queued message is sent once", async () => {
    await withStore(async (store) => {
      store.enqueueOutbox("peer1", "send once");
      const generation = store.upsertPeer("peer1", "fresh-context");
      const send = deferred<void>();
      const sendText = vi.fn(() => send.promise);
      const client = { sendText } as unknown as ILinkClient;

      const first = flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: generation,
      });
      const second = flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: generation,
      });
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledOnce());
      send.resolve();

      await expect(first).resolves.toEqual({ attempted: 1, delivered: 1, remaining: 0 });
      await expect(second).resolves.toEqual({ attempted: 0, delivered: 0, remaining: 0 });
      expect(sendText).toHaveBeenCalledOnce();
    });
  });

  it("persists a legacy client_id before attempting delivery", async () => {
    await withStore(async (store) => {
      const entry = store.enqueueOutbox("peer1", "legacy message");
      const generation = store.upsertPeer("peer1", "fresh-context");
      const savedClientIDs: Array<string | undefined> = [];
      const originalSave = store.save.bind(store);
      vi.spyOn(store, "save").mockImplementation(async () => {
        savedClientIDs.push(store.listPendingOutbox("peer1")[0]?.client_id);
        await originalSave();
      });
      const sendText = vi.fn(async () => { throw new Error("still pending"); });

      await flushPendingOutbox(
        { sendText } as unknown as ILinkClient,
        store,
        "peer1",
        { mode: "inbound", attemptGeneration: generation },
      );

      const clientID = store.listPendingOutbox("peer1")[0]?.client_id;
      expect(clientID).toMatch(/^wegate-/);
      expect(savedClientIDs[0]).toBe(clientID);
      expect(sendText).toHaveBeenCalledWith(
        "peer1",
        "legacy message",
        "fresh-context",
        clientID,
      );
      expect(entry.client_id).toBe(clientID);
    });
  });

  it("keeps a near-capacity legacy replay bounded and redacts its failure log", async () => {
    await withStore(async (store) => {
      const secret = "legacy-secret-token";
      const entry = {
        id: "11111111-1111-4111-8111-111111111111",
        peer_id: "peer1",
        text: "",
        queued_at: "2026-09-04T00:00:00.000Z",
        attempts: 0,
        last_error: "x".repeat(3_000),
      };
      const overhead = Buffer.byteLength(JSON.stringify([entry]), "utf8");
      entry.text = "a".repeat(MAX_OUTBOX_BYTES - overhead);
      expect(Buffer.byteLength(JSON.stringify([entry]), "utf8")).toBe(
        MAX_OUTBOX_BYTES,
      );
      store.session.pending_outbox = [entry];
      const originalText = entry.text;
      const generation = store.upsertPeer("peer1", "fresh-context");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = {
        sendText: vi.fn(async () => {
          throw new Error(`Authorization: Bearer ${secret}`);
        }),
      } as unknown as ILinkClient;

      const result = await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: generation,
      });

      expect(result).toMatchObject({ attempted: 1, delivered: 0, remaining: 1 });
      const pending = store.listPendingOutbox("peer1");
      expect(pending[0]?.text).toBe(originalText);
      expect(pending[0]?.client_id).toBe(`wegate-${entry.id}`);
      expect(Buffer.byteLength(JSON.stringify(pending), "utf8")).toBeLessThanOrEqual(
        MAX_OUTBOX_BYTES,
      );
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain(secret);
      expect(logged).toContain("[REDACTED]");
    });
  });

  it("keeps a failed item and does not retry it twice in the same inbound generation", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "reminder");
      const generation = store.upsertPeer("peer1", "fresh-context");
      const sendText = vi.fn(async () => {
        throw new Error("temporary network failure");
      });
      const client = { sendText } as unknown as ILinkClient;

      const options = { mode: "inbound", attemptGeneration: generation } as const;
      const first = await flushPendingOutbox(client, store, "peer1", options);
      const second = await flushPendingOutbox(client, store, "peer1", options);

      expect(first).toMatchObject({ attempted: 1, delivered: 0, remaining: 1 });
      expect(second).toEqual({ attempted: 0, delivered: 0, remaining: 1 });
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(store.listPendingOutbox("peer1")[0]).toMatchObject({
        attempts: 1,
        last_error: "temporary network failure",
      });
      vi.restoreAllMocks();
    });
  });

  it("does not skip a failed FIFO head until a new inbound generation", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "first");
      store.enqueueOutbox("peer1", "second");
      const firstGeneration = store.upsertPeer("peer1", "context-1");
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValue(undefined);
      const client = { sendText } as unknown as ILinkClient;

      const firstOptions = {
        mode: "inbound",
        attemptGeneration: firstGeneration,
      } as const;
      const failed = await flushPendingOutbox(client, store, "peer1", firstOptions);
      const sameGeneration = await flushPendingOutbox(
        client,
        store,
        "peer1",
        firstOptions,
      );

      expect(failed).toMatchObject({ attempted: 1, delivered: 0, remaining: 2 });
      expect(sameGeneration).toEqual({ attempted: 0, delivered: 0, remaining: 2 });
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(store.listPendingOutbox("peer1").map((entry) => entry.text)).toEqual([
        "first",
        "second",
      ]);

      const secondGeneration = store.upsertPeer("peer1", "context-2");
      const nextGeneration = await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: secondGeneration,
      });

      expect(nextGeneration).toEqual({ attempted: 2, delivered: 2, remaining: 0 });
      expect(sendText.mock.calls.map(([, text]) => text)).toEqual([
        "first",
        "first",
        "second",
      ]);
      expect(sendText.mock.calls.slice(1).map(([, , token]) => token)).toEqual([
        "context-2",
        "context-2",
      ]);
      expect(store.listPendingOutbox("peer1")).toEqual([]);
      vi.restoreAllMocks();
    });
  });

  it("retries once after the next inbound advances the context generation", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "reminder");
      const firstGeneration = store.upsertPeer("peer1", "context-1");
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(undefined);
      const client = { sendText } as unknown as ILinkClient;

      await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: firstGeneration,
      });
      const secondGeneration = store.upsertPeer("peer1", "context-2");
      const recovered = await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: secondGeneration,
      });

      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText.mock.calls[1]?.[2]).toBe("context-2");
      expect(recovered).toEqual({ attempted: 1, delivered: 1, remaining: 0 });
      vi.restoreAllMocks();
    });
  });

  it("retries a failed legacy FIFO after a later token-bearing inbound", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "first");
      store.enqueueOutbox("peer1", "second");
      const firstGeneration = store.upsertPeer("peer1");
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(new Error("old startup failure"))
        .mockResolvedValue(undefined);
      const client = { sendText } as unknown as ILinkClient;

      const startup = await flushPendingOutbox(client, store, "peer1", {
        mode: "startup",
      });
      const sameGeneration = await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: firstGeneration,
      });

      expect(startup).toMatchObject({ attempted: 1, delivered: 0, remaining: 2 });
      expect(sameGeneration).toEqual({ attempted: 0, delivered: 0, remaining: 2 });
      expect(sendText.mock.calls.map(([, text]) => text)).toEqual(["first"]);
      expect(store.listPendingOutbox("peer1").map((entry) => entry.text)).toEqual([
        "first",
        "second",
      ]);

      const secondGeneration = store.upsertPeer("peer1", "new-context");
      const nextGeneration = await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: secondGeneration,
      });

      expect(nextGeneration).toEqual({ attempted: 2, delivered: 2, remaining: 0 });
      expect(sendText.mock.calls.map(([, text]) => text)).toEqual([
        "first",
        "first",
        "second",
      ]);
      expect(sendText.mock.calls.slice(1).every(([, , token]) => token === "new-context")).toBe(true);
      expect(store.listPendingOutbox("peer1")).toEqual([]);
      vi.restoreAllMocks();
    });
  });

  it("does not reinterpret an upstream failure as context-token rejection", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "first");
      store.enqueueOutbox("peer1", "second");
      const generation = store.upsertPeer("peer1", "fresh-context");
      const client = {
        sendText: vi.fn(async () => {
          throw new Error("sendmessage ret=-2 errmsg=prepare failed");
        }),
      } as unknown as ILinkClient;

      await flushPendingOutbox(client, store, "peer1", {
        mode: "inbound",
        attemptGeneration: generation,
      });

      expect(store.getPeerOutboundStatus("peer1").ready).toBe(true);
      expect(store.listPendingOutbox("peer1").map((entry) => entry.text)).toEqual([
        "first",
        "second",
      ]);
      expect(store.listPendingOutbox("peer1").map((entry) => entry.attempts)).toEqual([1, 0]);
      vi.restoreAllMocks();
    });
  });
});
