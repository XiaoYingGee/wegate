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

describe("Router.parse — # prefix rules", () => {
  it("parses builtin commands with trailing space", () => {
    const router = new Router();
    expect(router.parse("#clear ")).toEqual({
      type: "command", command: "clear", args: "",
    });
  });

  it("parses builtin command with args", () => {
    const router = new Router();
    expect(router.parse("#help details")).toEqual({
      type: "command", command: "help", args: "details",
    });
  });

  it("parses processor prefix with message", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("#asset 查查我的资产")).toEqual({
      type: "message", processor: "asset", text: "查查我的资产",
    });
  });

  it("parses processor prefix with newline separator", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("#asset\n查查我的资产")).toEqual({
      type: "message", processor: "asset", text: "查查我的资产",
    });
  });

  it("parses processor prefix with only trailing space (switch only)", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("#asset ")).toEqual({
      type: "message", processor: "asset", text: undefined,
    });
  });

  it("treats bare #word (no trailing space) as a valid processor switch", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("#asset")).toEqual({
      type: "message", processor: "asset", text: undefined,
    });
  });

  it("treats #word joined with digits as an unrecognized command", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("#asset123")).toEqual({
      type: "command", command: "asset123", args: "",
    });
  });

  it("allows leading whitespace before #", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("  #asset 查查")).toEqual({
      type: "message", processor: "asset", text: "查查",
    });
  });

  it("rejects non-whitespace characters before #", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("hello #asset 查查")).toEqual({
      type: "message", text: "hello #asset 查查",
    });
  });

  it("rejects space between # and word", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("# asset 查查")).toEqual({
      type: "message", text: "# asset 查查",
    });
  });

  it("is case insensitive for command names", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.parse("#Asset 查查")).toMatchObject({
      processor: "asset",
    });
  });

  it("treats unknown # prefix as an unrecognized command", () => {
    const router = new Router();
    expect(router.parse("#unknown 查查")).toEqual({
      type: "command", command: "unknown", args: "查查",
    });
  });

  it("parses plain text without # as message", () => {
    const router = new Router();
    expect(router.parse("hello world")).toEqual({
      type: "message", text: "hello world",
    });
  });

  it("strips the #command header from forwarded text", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    const result = router.parse("#asset 查查我的资产");
    expect(result.text).toBe("查查我的资产");
    expect(result.text).not.toContain("#asset");
  });
});

describe("Router.resolve (sticky routing)", () => {
  it("resolves to default when no active processor", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    const resolved = router.resolve("user1", router.parse("hello"));
    expect(resolved?.name).toBe("claude");
  });

  it("sticks to explicitly selected processor", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });

    router.resolve("user1", router.parse("#asset 查查"));
    const resolved = router.resolve("user1", router.parse("那黄金呢"));
    expect(resolved?.name).toBe("asset");
  });

  it("isolates routing per chat_id", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });

    router.resolve("user1", router.parse("#asset 查查"));
    const resolved = router.resolve("user2", router.parse("hello"));
    expect(resolved?.name).toBe("claude");
  });

  it("switchTo changes active processor", () => {
    const router = new Router();
    router.registerProcessor(mockProcessor("claude"), { isDefault: true });
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });

    router.resolve("user1", router.parse("#asset test"));
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
    router.registerProcessor(mockProcessor("asset"), { prefix: "#asset" });
    expect(router.listProcessors()).toEqual(["claude", "asset"]);
  });
});
