import { describe, it, expect, vi } from "vitest";
import {
  buildCommandList,
  flushAllowedPendingOutbox,
  isSenderAllowed,
} from "../src/index.js";
import { Router } from "../src/router.js";
import type { ILinkClient } from "../src/client/ilink.js";
import type { SessionStore } from "../src/store/session.js";
import type { Processor } from "../src/types.js";

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
    );

    expect(result).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
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
