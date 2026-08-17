import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ILinkSendError, type ILinkClient } from "../src/client/ilink.js";
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
  it("flushes queued messages FIFO after a fresh inbound context", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "first");
      store.enqueueOutbox("peer1", "second");
      store.upsertPeer("peer1", "fresh-context");

      const sent: string[] = [];
      const client = {
        sendText: vi.fn(async (_peer: string, text: string) => {
          sent.push(text);
        }),
      } as unknown as ILinkClient;

      const result = await flushPendingOutbox(client, store, "peer1");

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
      store.upsertPeer("peer1", "fresh-context");
      const sendText = vi.fn(async () => {
        throw new Error("temporary network failure");
      });
      const client = { sendText } as unknown as ILinkClient;

      const first = await flushPendingOutbox(client, store, "peer1");
      const second = await flushPendingOutbox(client, store, "peer1");

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

  it("retries once after the next inbound advances the context generation", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "reminder");
      store.upsertPeer("peer1", "context-1");
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(undefined);
      const client = { sendText } as unknown as ILinkClient;

      await flushPendingOutbox(client, store, "peer1");
      store.upsertPeer("peer1", "context-2");
      const recovered = await flushPendingOutbox(client, store, "peer1");

      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText.mock.calls[1]?.[2]).toBe("context-2");
      expect(recovered).toEqual({ attempted: 1, delivered: 1, remaining: 0 });
      vi.restoreAllMocks();
    });
  });

  it("does not let an old in-flight failure invalidate a newer inbound context", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "reminder");
      store.upsertPeer("peer1", "context-1");

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

      const firstFlush = flushPendingOutbox(client, store, "peer1");
      await started;
      store.upsertPeer("peer1", "context-2");
      rejectOld(new ILinkSendError(-2, "prepare failed"));
      await firstFlush;

      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: true,
        contextToken: "context-2",
      });
      const recovered = await flushPendingOutbox(client, store, "peer1");
      expect(recovered).toEqual({ attempted: 1, delivered: 1, remaining: 0 });
      expect(sendText.mock.calls[1]?.[2]).toBe("context-2");
      vi.restoreAllMocks();
    });
  });

  it("marks ret=-2 as context rejected and leaves later FIFO items untouched", async () => {
    await withStore(async (store) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      store.enqueueOutbox("peer1", "first");
      store.enqueueOutbox("peer1", "second");
      store.upsertPeer("peer1", "fresh-context");
      const client = {
        sendText: vi.fn(async () => {
          throw new ILinkSendError(-2, "prepare failed");
        }),
      } as unknown as ILinkClient;

      await flushPendingOutbox(client, store, "peer1");

      expect(store.getPeerOutboundStatus("peer1")).toMatchObject({
        ready: false,
        reason: "context_rejected",
      });
      expect(store.listPendingOutbox("peer1").map((entry) => entry.text)).toEqual([
        "first",
        "second",
      ]);
      expect(store.listPendingOutbox("peer1").map((entry) => entry.attempts)).toEqual([1, 0]);
      vi.restoreAllMocks();
    });
  });
});
