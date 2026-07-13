import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getApiToken, getAllowedSenders } from "../src/config.js";

const ENV_KEYS = ["WEGATE_API_TOKEN", "WEGATE_ALLOWED_SENDERS"] as const;
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
