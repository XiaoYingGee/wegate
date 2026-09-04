import { describe, it, expect, vi, afterEach } from "vitest";
import { startMessageLoop, enqueueSerial } from "../src/bridge.js";
import type { ILinkClient, WeixinMessage } from "../src/client/ilink.js";
import { SessionStore } from "../src/store/session.js";
import { flushAllowedPendingOutbox } from "../src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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

describe("startMessageLoop — getUpdates business errors", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "ret-only",
      response: { ret: 7, errmsg: "ret failure" },
      code: 7,
    },
    {
      label: "errcode=0 with non-zero ret",
      response: { errcode: 0, ret: -2, errmsg: "prepare failed" },
      code: -2,
    },
  ])("backs off and ignores $label responses", async ({ response, code }) => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce({
        ...response,
        msgs: [makeMsg("peer1", "must not run")],
        get_updates_buf: "buf-new",
      })
      .mockImplementation(() => new Promise<never>(() => {}));
    const store = {
      session: { get_updates_buf: "buf-old" },
      upsertPeer: vi.fn(),
      save: vi.fn(),
      setUpdatesBuf: vi.fn(),
    } as unknown as SessionStore;
    const onMessage = vi.fn();

    void startMessageLoop({ getUpdates } as unknown as ILinkClient, store, onMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(store.upsertPeer).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(store.setUpdatesBuf).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`code=${code}`),
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(2);
    expect(getUpdates.mock.calls[1]?.[0]).toBe("buf-old");
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

describe("startMessageLoop — cursor advances only after successful handlers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not update the cursor while a handler is still running", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce({
        errcode: 0,
        msgs: [makeMsg("peer1", "hi")],
        get_updates_buf: "buf2",
      })
      .mockImplementation(() => new Promise<never>(() => {}));
    const session = { get_updates_buf: "buf1" };
    const store = {
      session,
      upsertPeer: vi.fn(() => 1),
      save: vi.fn(async () => {}),
      setUpdatesBuf: vi.fn((buf: string) => {
        session.get_updates_buf = buf;
      }),
    } as unknown as SessionStore;
    const onMessage = vi.fn(async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;
    });

    void startMessageLoop({ getUpdates } as unknown as ILinkClient, store, onMessage);
    await handlerStarted.promise;

    expect(store.setUpdatesBuf).not.toHaveBeenCalled();
    expect(session.get_updates_buf).toBe("buf1");

    releaseHandler.resolve();
    const deadline = Date.now() + 1_000;
    while (!vi.mocked(store.setUpdatesBuf).mock.calls.length && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5));
    }

    expect(store.setUpdatesBuf).toHaveBeenCalledWith("buf2");
    expect(session.get_updates_buf).toBe("buf2");
  });

  it("keeps the old cursor after failure and redelivers the batch", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = {
      errcode: 0,
      msgs: [makeMsg("peer1", "retry me")],
      get_updates_buf: "buf2",
    };
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(batch)
      .mockImplementation(() => new Promise<never>(() => {}));
    const session = { get_updates_buf: "buf1" };
    let generation = 0;
    const store = {
      session,
      upsertPeer: vi.fn(() => {
        generation += 1;
        return generation;
      }),
      save: vi.fn(async () => {}),
      setUpdatesBuf: vi.fn((buf: string) => {
        session.get_updates_buf = buf;
      }),
    } as unknown as SessionStore;
    const onMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("handler failed"))
      .mockResolvedValueOnce(undefined);

    void startMessageLoop({ getUpdates } as unknown as ILinkClient, store, onMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(getUpdates.mock.calls[0]?.[0]).toBe("buf1");
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(store.setUpdatesBuf).not.toHaveBeenCalled();
    expect(session.get_updates_buf).toBe("buf1");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(getUpdates.mock.calls[1]?.[0]).toBe("buf1");
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(store.setUpdatesBuf).toHaveBeenCalledWith("buf2");
    expect(session.get_updates_buf).toBe("buf2");
    vi.useRealTimers();
  });

  it("persists the new cursor only after every handler succeeds", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const msgs = [makeMsg("peer1", "hi1"), makeMsg("peer2", "hi2")];

    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce({ errcode: 0, msgs, get_updates_buf: "buf2" })
      .mockImplementation(() => new Promise<never>(() => {}));

    const client = { getUpdates } as unknown as ILinkClient;

    const order: string[] = [];
    const store = {
      session: { get_updates_buf: "buf1" },
      upsertPeer: vi.fn((from: string) => {
        order.push(`upsertPeer:${from}`);
        return 1;
      }),
      save: vi.fn(async () => {
        order.push("save");
      }),
      setUpdatesBuf: vi.fn(() => order.push("setUpdatesBuf")),
    } as unknown as SessionStore;

    const onMessage = vi.fn(async (from: string) => {
      order.push(`handler:${from}`);
    });

    void startMessageLoop(client, store, onMessage);
    await new Promise((r) => setTimeout(r, 50));

    const cursorIndex = order.indexOf("setUpdatesBuf");
    expect(cursorIndex).toBeGreaterThan(-1);
    expect(order.indexOf("upsertPeer:peer1")).toBeLessThan(cursorIndex);
    expect(order.indexOf("upsertPeer:peer2")).toBeLessThan(cursorIndex);
    expect(order.indexOf("handler:peer1")).toBeLessThan(cursorIndex);
    expect(order.indexOf("handler:peer2")).toBeLessThan(cursorIndex);
  });
});

describe("startMessageLoop — per-message inbound generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets a later token-bearing same-peer message retry an outbox item", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await mkdtemp(resolve(tmpdir(), "wegate-bridge-generation-test-"));

    try {
      const store = new SessionStore(resolve(dir, "session.json"));
      store.enqueueOutbox("peer1", "legacy message");
      await store.save();

      const bothInboundSaved = deferred<void>();
      const originalSave = store.save.bind(store);
      let inboundSaveCount = 0;
      vi.spyOn(store, "save").mockImplementation(async () => {
        await originalSave();
        inboundSaveCount += 1;
        if (inboundSaveCount === 2) bothInboundSaved.resolve();
      });

      const msgs: WeixinMessage[] = [
        {
          from_user_id: "peer1",
          context_token: "context-1",
          item_list: [{ type: 1, text_item: { text: "first inbound" } }],
        },
        {
          from_user_id: "peer1",
          context_token: "context-2",
          item_list: [{ type: 1, text_item: { text: "second inbound" } }],
        },
      ];
      const getUpdates = vi
        .fn()
        .mockResolvedValueOnce({ errcode: 0, msgs })
        .mockImplementation(() => new Promise<never>(() => {}));
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(new Error("first inbound send failed"))
        .mockResolvedValueOnce(undefined);
      const client = { getUpdates, sendText } as unknown as ILinkClient;

      const handlerGenerations: number[] = [];
      const currentGenerationsAtFlush: number[] = [];
      const flushResults: Array<Awaited<ReturnType<typeof flushAllowedPendingOutbox>>> = [];
      const onMessage = vi.fn(
        async (
          from: string,
          _text: string,
          msg: WeixinMessage,
          inboundGeneration: number,
        ) => {
          handlerGenerations.push(inboundGeneration);
          if (inboundGeneration === 1) await bothInboundSaved.promise;
          currentGenerationsAtFlush.push(
            store.getPeerOutboundStatus(from).tokenGeneration,
          );
          flushResults.push(
            await flushAllowedPendingOutbox(
              client,
              store,
              from,
              undefined,
              inboundGeneration,
              msg.context_token,
            ),
          );
        },
      );

      void startMessageLoop(client, store, onMessage);

      const deadline = Date.now() + 1_000;
      while (flushResults.length < 2 && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 5));
      }

      expect(handlerGenerations).toEqual([1, 2]);
      expect(currentGenerationsAtFlush).toEqual([2, 2]);
      expect(flushResults[0]).toMatchObject({
        attempted: 1,
        delivered: 0,
        remaining: 1,
      });
      expect(flushResults[1]).toEqual({
        attempted: 1,
        delivered: 1,
        remaining: 0,
      });
      expect(sendText.mock.calls).toEqual([
        ["peer1", "legacy message", "context-2", expect.stringMatching(/^wegate-/)],
        ["peer1", "legacy message", "context-2", expect.stringMatching(/^wegate-/)],
      ]);
      expect(sendText.mock.calls[1]?.[3]).toBe(sendText.mock.calls[0]?.[3]);
      expect(store.listPendingOutbox("peer1")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
