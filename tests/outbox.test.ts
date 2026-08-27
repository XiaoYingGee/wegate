import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ILinkClient } from "../src/client/ilink.js";
import { flushPendingOutbox } from "../src/outbox.js";
import { SessionStore } from "../src/store/session.js";

async function withStore(fn: (store: SessionStore) => Promise<void>) {
  const dir = await mkdtemp(resolve(tmpdir(), "wegate-outbox-test-"));
  try {
    await fn(new SessionStore(resolve(dir, "session.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

  it("retries a tokenless legacy FIFO only after the next tokenless inbound", async () => {
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

      const secondGeneration = store.upsertPeer("peer1");
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
      expect(sendText.mock.calls.every(([, , token]) => token === undefined)).toBe(true);
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
