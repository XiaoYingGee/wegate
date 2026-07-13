import { describe, it, expect, vi, afterEach } from "vitest";
import { startMessageLoop, enqueueSerial } from "../src/bridge.js";
import type { ILinkClient, WeixinMessage } from "../src/client/ilink.js";
import type { SessionStore } from "../src/store/session.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMsg(from: string, text: string): WeixinMessage {
  return {
    from_user_id: from,
    context_token: `ctx-${from}`,
    item_list: [{ type: 1, text_item: { text } }],
  } as WeixinMessage;
}

describe("enqueueSerial (BUG-12: pending map cleanup)", () => {
  it("runs tasks for the same key strictly in FIFO order", async () => {
    const pending = new Map<string, Promise<void>>();
    const order: number[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const t1 = enqueueSerial(
      pending,
      "peer1",
      async () => {
        await d1.promise;
        order.push(1);
      },
      () => {},
    );
    const t2 = enqueueSerial(
      pending,
      "peer1",
      async () => {
        await d2.promise;
        order.push(2);
      },
      () => {},
    );

    d2.resolve();
    d1.resolve();
    await Promise.all([t1, t2]);

    expect(order).toEqual([1, 2]);
  });

  it("removes the pending entry once the task settles", async () => {
    const pending = new Map<string, Promise<void>>();
    const task = enqueueSerial(pending, "peer1", async () => {}, () => {});
    expect(pending.has("peer1")).toBe(true);
    await task;
    expect(pending.has("peer1")).toBe(false);
  });

  it("invokes onError and still cleans up the pending entry when work throws", async () => {
    const pending = new Map<string, Promise<void>>();
    const errors: unknown[] = [];
    const task = enqueueSerial(
      pending,
      "peer1",
      async () => {
        throw new Error("boom");
      },
      (e) => errors.push(e),
    );

    await expect(task).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(pending.has("peer1")).toBe(false);
  });

  it("does not let an older task's cleanup delete a newer task's still-pending slot (race safety)", async () => {
    const pending = new Map<string, Promise<void>>();
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const t1 = enqueueSerial(pending, "peer1", async () => { await d1.promise; }, () => {});
    const t2 = enqueueSerial(pending, "peer1", async () => { await d2.promise; }, () => {});

    expect(pending.get("peer1")).toBe(t2);

    d1.resolve();
    await t1; // t1's own .finally (attached before this await) has already run by now

    // t2 has not settled yet — its slot must still be present, not wiped by t1's cleanup
    expect(pending.get("peer1")).toBe(t2);

    d2.resolve();
    await t2;
    expect(pending.has("peer1")).toBe(false);
  });

  it("keeps distinct keys independent", async () => {
    const pending = new Map<string, Promise<void>>();
    const order: string[] = [];

    const t1 = enqueueSerial(pending, "peerA", async () => { order.push("A"); }, () => {});
    const t2 = enqueueSerial(pending, "peerB", async () => { order.push("B"); }, () => {});

    await Promise.all([t1, t2]);
    expect(pending.size).toBe(0);
    expect(order.sort()).toEqual(["A", "B"]);
  });
});

describe("startMessageLoop — per-message error isolation (BUG-7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps processing later messages in the same batch after an earlier message's persistence throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const msgs = [makeMsg("peer1", "hi1"), makeMsg("peer2", "hi2"), makeMsg("peer3", "hi3")];

    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce({ errcode: 0, msgs, get_updates_buf: "buf1" })
      .mockRejectedValue(new Error("stop-loop-for-test"));

    const client = { getUpdates } as unknown as ILinkClient;

    let saveCallCount = 0;
    const upsertPeer = vi.fn();
    const save = vi.fn(async () => {
      saveCallCount += 1;
      if (saveCallCount === 2) {
        // simulate the 2nd message's persistence failing (e.g. disk error)
        throw new Error("disk full");
      }
    });

    const store = {
      session: { get_updates_buf: "buf1" },
      upsertPeer,
      save,
      setUpdatesBuf: vi.fn(),
    } as unknown as SessionStore;

    const received: string[] = [];
    const onMessage = vi.fn(async (from: string) => {
      received.push(from);
    });

    // startMessageLoop never resolves by design (Promise<never>); fire and forget.
    void startMessageLoop(client, store, onMessage);

    // give the microtask/macrotask queue enough real time to process the one batch
    await new Promise((r) => setTimeout(r, 50));

    expect(upsertPeer).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(3);
    // peer2's save() failure must not stop peer3 from being processed
    expect(received).toEqual(["peer1", "peer3"]);
  });
});
