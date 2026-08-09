import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getApiToken,
  getAllowedSenders,
  getClaudeCwd,
  getCodexCwd,
  loadConfig,
} from "../src/config.js";

const ENV_KEYS = [
  "WEGATE_API_TOKEN",
  "WEGATE_ALLOWED_SENDERS",
  "WEGATE_CLAUDE_CWD",
  "WEGATE_CODEX_CWD",
  "WEGATE_ENABLE_CLAUDE",
  "WEGATE_ENABLE_CODEX",
  "WEGATE_CODEX_CMD",
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
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("不存在或不是目录"));
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
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WEGATE_CODEX_CWD"));
  });
});

describe("loadConfig Codex processor", () => {
  it("registers #codex with the configured local command and cwd by default", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_ENABLE_CLAUDE = "false";
    process.env.WEGATE_CODEX_CMD = "/usr/bin/codex";
    process.env.WEGATE_CODEX_CWD = process.cwd();

    expect(loadConfig().processors).toContainEqual({
      name: "codex",
      type: "codex",
      command: "/usr/bin/codex",
      cwd: process.cwd(),
      prefix: "#codex",
    });
  });

  it("can disable the Codex processor", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WEGATE_ENABLE_CLAUDE = "false";
    process.env.WEGATE_ENABLE_CODEX = "false";
    expect(loadConfig().processors).not.toContainEqual(
      expect.objectContaining({ type: "codex" }),
    );
  });
});
