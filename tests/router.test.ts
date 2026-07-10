import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import type { Processor, ProcessorResponse } from "../src/types.js";

function mockProcessor(name: string): Processor {
  const sessions = new Set<string>();
  return {
    name,
    async send(message: string, chatId: string): Promise<ProcessorResponse> {
      sessions.add(chatId);
      return { text: `[${name}] ${message}` };
    },
    async clearSession(chatId: string) {
      sessions.delete(chatId);
    },
  };
}

describe("Router.parse", () => {
  it("parses builtin commands", () => {
    const router = new Router();
    const result = router.parse("/clear");
    expect(result).toEqual({ type: "command", command: "clear", args: "" });
  });

  it("parses builtin command with args", () => {
    const router = new Router();
    const result = router.parse("/help details");
    expect(result).toEqual({ type: "command", command: "help", args: "details" });
  });

  it("parses prefix route with message", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });
    const result = router.parse("/asset 查查我的资产");
    expect(result).toEqual({
      type: "message",
      processor: "asset",
      text: "查查我的资产",
    });
  });

  it("parses prefix route without message", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });
    const result = router.parse("/asset");
    expect(result).toEqual({
      type: "message",
      processor: "asset",
      text: undefined,
    });
  });

  it("parses plain text as message", () => {
    const router = new Router();
    const result = router.parse("hello world");
    expect(result).toEqual({ type: "message", text: "hello world" });
  });

  it("treats unknown slash as plain text", () => {
    const router = new Router();
    const result = router.parse("/unknown command");
    expect(result).toEqual({ type: "message", text: "/unknown command" });
  });

  it("is case insensitive for prefixes", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });
    const result = router.parse("/Asset 查查");
    expect(result.processor).toBe("asset");
  });
});

describe("Router.resolve (sticky routing)", () => {
  it("resolves to default when no active processor", () => {
    const router = new Router();
    const claude = mockProcessor("claude");
    router.registerProcessor(claude, { isDefault: true });

    const parsed = router.parse("hello");
    const resolved = router.resolve("user1", parsed);
    expect(resolved?.name).toBe("claude");
  });

  it("sticks to explicitly selected processor", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });

    const parsed1 = router.parse("/asset 查查");
    router.resolve("user1", parsed1);

    const parsed2 = router.parse("那黄金呢");
    const resolved = router.resolve("user1", parsed2);
    expect(resolved?.name).toBe("asset");
  });

  it("isolates routing per chat_id", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });

    router.resolve("user1", router.parse("/asset 查查"));

    const resolved = router.resolve("user2", router.parse("hello"));
    expect(resolved?.name).toBe("claude");
  });

  it("switchTo changes active processor", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });

    router.resolve("user1", router.parse("/asset test"));
    expect(router.getActive("user1")).toBe("asset");

    router.switchTo("user1", "claude");
    expect(router.getActive("user1")).toBe("claude");
  });

  it("switchTo returns false for unknown processor", () => {
    const router = new Router();
    expect(router.switchTo("user1", "nonexistent")).toBe(false);
  });
});

describe("Router.listProcessors", () => {
  it("lists registered processors", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "/asset" });
    expect(router.listProcessors()).toEqual(["claude", "asset"]);
  });
});
