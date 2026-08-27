import { describe, it, expect, vi } from "vitest";
import {
  buildCommandList,
  flushAllowedPendingOutbox,
  flushLegacyPendingOutbox,
  isSenderAllowed,
  reply,
} from "../src/index.js";
import { Router } from "../src/router.js";
import type { ILinkClient } from "../src/client/ilink.js";
import { SessionStore } from "../src/store/session.js";
import type { Processor } from "../src/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

describe("isSenderAllowed (BUG-5 sender whitelist)", () => {
  it("allows any sender when allowedSenders is undefined", () => {
    expect(isSenderAllowed("anyone", undefined)).toBe(true);
  });

  it("allows any sender when allowedSenders is an empty array", () => {
    expect(isSenderAllowed("anyone", [])).toBe(true);
  });

  it("allows a sender present in the whitelist", () => {
    expect(isSenderAllowed("alice", ["alice", "bob"])).toBe(true);
  });

  it("rejects a sender not present in the whitelist", () => {
    expect(isSenderAllowed("mallory", ["alice", "bob"])).toBe(false);
  });

  it("does not let an unauthorized sender trigger pending outbox delivery", async () => {
    const sendText = vi.fn();
    const store = {
      getPeerOutboundStatus: vi.fn(() => {
        throw new Error("outbox must not be inspected");
      }),
    } as unknown as SessionStore;

    const result = await flushAllowedPendingOutbox(
      { sendText } as unknown as ILinkClient,
      store,
      "mallory",
      ["alice"],
      1,
    );

    expect(result).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("recovers authorized legacy outbox entries at startup without inbound", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "wegate-index-test-"));
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const store = new SessionStore(resolve(dir, "session.json"));
      store.upsertPeer("alice");
      store.upsertPeer("mallory");
      store.enqueueOutbox("alice", "allowed legacy message");
      store.enqueueOutbox("mallory", "blocked legacy message");
      const sendText = vi.fn(async () => {});

      await flushLegacyPendingOutbox(
        { sendText } as unknown as ILinkClient,
        store,
        ["alice"],
      );

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith("alice", "allowed legacy message", undefined);
      expect(store.listPendingOutbox("alice")).toEqual([]);
      expect(store.listPendingOutbox("mallory")).toHaveLength(1);
      vi.restoreAllMocks();
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCommandList", () => {
  const processor = (name: string): Processor => ({
    name,
    async send() { return { text: "ok" }; },
    async clearSession() {},
  });

  it("only shows built-in CLI commands whose processors are registered", () => {
    const router = new Router();
    router.registerProcessor(processor("codex"), { prefix: "#codex" });
    const help = buildCommandList(router);
    expect(help).toContain("#codex");
    expect(help).not.toContain("#claude");
  });

  it("does not show #codex when the processor is disabled", () => {
    const router = new Router();
    router.registerProcessor(processor("claude"), { isDefault: true });
    const help = buildCommandList(router);
    expect(help).toContain("#claude");
    expect(help).not.toContain("#codex");
  });
});

describe("reply", () => {
  it("calls iLink for an ordinary reply even without a context token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sendText = vi.fn(async () => {});
    const store = {
      getPeerToken: vi.fn(() => undefined),
    } as unknown as SessionStore;

    await reply(
      { sendText } as unknown as ILinkClient,
      store,
      "peer-without-token",
      "ordinary reply",
    );

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      "peer-without-token",
      "ordinary reply",
      undefined,
    );
    vi.restoreAllMocks();
  });

  it("continues forwarding a stored context token on ordinary replies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sendText = vi.fn(async () => {});
    const store = {
      getPeerToken: vi.fn(() => "stored-context"),
    } as unknown as SessionStore;

    await reply(
      { sendText } as unknown as ILinkClient,
      store,
      "peer-with-token",
      "ordinary reply",
    );

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      "peer-with-token",
      "ordinary reply",
      "stored-context",
    );
    vi.restoreAllMocks();
  });

  it("uses the optional token for long chunks and the failure notice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sendText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second chunk failed"))
      .mockResolvedValueOnce(undefined);
    const store = {
      getPeerToken: vi.fn(() => undefined),
    } as unknown as SessionStore;
    const longReply = "x".repeat(4_001);

    await reply(
      { sendText } as unknown as ILinkClient,
      store,
      "peer-without-token",
      longReply,
    );

    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText.mock.calls).toEqual([
      ["peer-without-token", "x".repeat(2_000), undefined],
      ["peer-without-token", "x".repeat(2_000), undefined],
      ["peer-without-token", "（后续内容发送失败，请稍后重试）", undefined],
    ]);
    vi.restoreAllMocks();
  });

  it("does not split an emoji surrogate pair at the chunk boundary", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sendText = vi.fn(async () => {});
    const store = {
      getPeerToken: vi.fn(() => "stored-context"),
    } as unknown as SessionStore;
    const original = `${"x".repeat(1_999)}😀tail`;

    await reply(
      { sendText } as unknown as ILinkClient,
      store,
      "peer-with-token",
      original,
    );

    const chunks = sendText.mock.calls.map(([, chunk]) => chunk);
    expect(chunks).toEqual(["x".repeat(1_999), "😀tail"]);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => !hasIsolatedSurrogate(chunk))).toBe(true);
    expect(chunks.join("")).toBe(original);
    vi.restoreAllMocks();
  });
});

function hasIsolatedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
