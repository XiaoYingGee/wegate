import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getApiToken,
  getAllowedSenders,
  getClaudeCwd,
  getCodexCwd,
  loadConfig,
} from "../src/config.js";
import { Router } from "../src/router.js";
import type { Processor } from "../src/types.js";

const ENV_KEYS = [
  "WEGATE_API_TOKEN",
  "WEGATE_ALLOWED_SENDERS",
  "WEGATE_CLAUDE_CWD",
  "WEGATE_CODEX_CWD",
  "WEGATE_ENABLE_CLAUDE",
  "WEGATE_ENABLE_CODEX",
  "WEGATE_CODEX_CMD",
  "WEGATE_ASSET_URL",
  "WEGATE_PROCESSORS",
  "HOME",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("getApiToken", () => {
  it("returns undefined when WEGATE_API_TOKEN is unset", () => {
    expect(getApiToken()).toBeUndefined();
  });

  it("returns undefined when WEGATE_API_TOKEN is blank", () => {
    process.env.WEGATE_API_TOKEN = "   ";
    expect(getApiToken()).toBeUndefined();
  });

  it("returns the trimmed token when set", () => {
    process.env.WEGATE_API_TOKEN = "  s3cr3t  ";
    expect(getApiToken()).toBe("s3cr3t");
  });
});

describe("getAllowedSenders", () => {
  it("returns undefined when WEGATE_ALLOWED_SENDERS is unset", () => {
    expect(getAllowedSenders()).toBeUndefined();
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    process.env.WEGATE_ALLOWED_SENDERS = " user1, user2 ,user3";
    expect(getAllowedSenders()).toEqual(["user1", "user2", "user3"]);
  });

  it("drops empty entries", () => {
    process.env.WEGATE_ALLOWED_SENDERS = "user1,,  ,user2";
    expect(getAllowedSenders()).toEqual(["user1", "user2"]);
  });

  it("returns undefined when the list is empty after trimming", () => {
    process.env.WEGATE_ALLOWED_SENDERS = " , , ";
    expect(getAllowedSenders()).toBeUndefined();
  });
});

describe("getClaudeCwd", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to $HOME when WEGATE_CLAUDE_CWD is unset", () => {
    delete process.env.WEGATE_CLAUDE_CWD;
    process.env.HOME = "/home/testuser";
    expect(getClaudeCwd()).toBe("/home/testuser");
  });

  it("returns the configured path when it exists and is a directory", () => {
    process.env.WEGATE_CLAUDE_CWD = process.cwd();
    expect(getClaudeCwd()).toBe(process.cwd());
  });

  it("warns and falls back to $HOME when the configured path does not exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_CLAUDE_CWD = "/definitely/does/not/exist/xyz";
    process.env.HOME = "/home/testuser";

    expect(getClaudeCwd()).toBe("/home/testuser");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("不存在或不是目录"),
    );
  });
});

describe("getCodexCwd", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to $HOME when WEGATE_CODEX_CWD is unset", () => {
    process.env.HOME = "/home/testuser";
    expect(getCodexCwd()).toBe("/home/testuser");
  });

  it("returns an existing configured directory", () => {
    process.env.WEGATE_CODEX_CWD = process.cwd();
    expect(getCodexCwd()).toBe(process.cwd());
  });

  it("warns and falls back for an invalid directory", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_CODEX_CWD = "/definitely/does/not/exist/codex";
    process.env.HOME = "/home/testuser";
    expect(getCodexCwd()).toBe("/home/testuser");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("WEGATE_CODEX_CWD"),
    );
  });
});

describe("loadConfig Codex processor", () => {
  it("uses Codex as default and keeps #claude available", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_CODEX_CMD = "/usr/bin/codex";
    process.env.WEGATE_CODEX_CWD = process.cwd();

    expect(loadConfig().processors).toContainEqual({
      name: "codex",
      type: "codex",
      command: "/usr/bin/codex",
      cwd: process.cwd(),
      prefix: "#codex",
      default: true,
    });
    expect(loadConfig().processors).toContainEqual({
      name: "claude",
      type: "claude",
      command: "claude",
      cwd: undefined,
      prefix: "#claude",
      default: false,
    });
  });

  it("keeps Codex as the resolved default when an extra processor requests default", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_PROCESSORS = JSON.stringify([
      { name: "custom", type: "http", url: "http://localhost", default: true },
    ]);

    const config = loadConfig();
    expect(config.processors.filter((processor) => processor.default)).toEqual([
      expect.objectContaining({ name: "codex" }),
    ]);

    const router = new Router();
    for (const processorConfig of config.processors) {
      const processor: Processor = {
        name: processorConfig.name,
        send: async () => ({ text: "ok" }),
        clearSession: async () => {},
      };
      router.registerProcessor(processor, {
        isDefault: processorConfig.default,
      });
    }
    expect(
      router.resolve("chat", { type: "message", text: "hello" })?.name,
    ).toBe("codex");
  });

  it("falls back to Claude as default when Codex is disabled", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_ENABLE_CODEX = "false";
    expect(loadConfig().processors).toEqual([
      expect.objectContaining({
        type: "claude",
        default: true,
        prefix: "#claude",
      }),
    ]);
  });

  it("uses Codex as default when Claude is disabled", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_ENABLE_CLAUDE = "false";
    expect(loadConfig().processors).toEqual([
      expect.objectContaining({ type: "codex", default: true }),
    ]);
  });

  it("makes an extra processor the default when both built-ins are disabled", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_ENABLE_CLAUDE = "false";
    process.env.WEGATE_ENABLE_CODEX = "false";
    process.env.WEGATE_PROCESSORS = JSON.stringify([
      { name: "custom", type: "http", url: "http://localhost" },
    ]);
    expect(loadConfig().processors).toEqual([
      expect.objectContaining({ name: "custom", default: true }),
    ]);
  });

  it("fails clearly when both built-in processors are disabled", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_ENABLE_CLAUDE = "false";
    process.env.WEGATE_ENABLE_CODEX = "false";
    expect(() => loadConfig()).toThrow(
      "没有可用的处理器，请至少启用一个 processor",
    );
  });
});
