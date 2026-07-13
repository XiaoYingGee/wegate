import { describe, it, expect } from "vitest";
import { isSenderAllowed } from "../src/index.js";

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
});
