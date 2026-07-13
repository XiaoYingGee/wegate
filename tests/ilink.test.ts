import { describe, it, expect, vi, afterEach } from "vitest";
import { ILinkClient } from "../src/client/ilink.js";

describe("ILinkClient.sendText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when iLink returns success (errcode 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });

  it("resolves when iLink returns an empty body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });

  it("throws with errcode/errmsg when iLink rejects at the application layer (e.g. expired context_token)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ errcode: 10008, errmsg: "context_token expired" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).rejects.toThrow(
      /errcode=10008.*context_token expired/,
    );

    vi.restoreAllMocks();
  });

  it("throws when only `ret` (not errcode) signals failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 1, errmsg: "unknown error" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).rejects.toThrow(
      /1/,
    );

    vi.restoreAllMocks();
  });

  it("throws a distinct HTTP-layer error when the request itself fails (non-2xx)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).rejects.toThrow(
      /HTTP 500/,
    );

    vi.restoreAllMocks();
  });

  it("replaces \\n/\\r\\n/\\r with U+2028 (WeChat client renders \\n as no line break at all)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await client.sendText("peer1", "line1\nline2\r\nline3\rline4", "ctx");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.msg.item_list[0].text_item.text).toBe(
      "line1 line2 line3 line4",
    );

    vi.restoreAllMocks();
  });
});
