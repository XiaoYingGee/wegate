import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  ILinkClient,
  ILinkSendError,
  ILinkTimeoutError,
  isTokenlessFallbackFailure,
} from "../src/client/ilink.js";

describe("ILinkClient", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("sends without a context_token when none has been captured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await client.sendText("peer1", "hello");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.msg).not.toHaveProperty("context_token");
  });

  it("generates a unique client_id for concurrent sends", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const requestBodies: Array<{ msg: { client_id: string } }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new ILinkClient("https://example.com", "tok");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        client.sendText("peer1", `message-${index}`, "ctx"),
      ),
    );

    const clientIds = requestBodies.map(({ msg }) => msg.client_id);
    expect(clientIds).toHaveLength(20);
    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(
      clientIds.every((id) =>
        /^wegate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
      ),
    ).toBe(true);
  });

  it("aborts an ordinary send after the official 15-second timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const client = new ILinkClient("https://example.com", "tok");
    const send = client.sendText("peer1", "hello", "ctx");
    const rejection = send.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_TIMEOUT_MS);
    const error = await rejection;
    expect(error).toBeInstanceOf(ILinkTimeoutError);
    expect(error).toMatchObject({
      name: "ILinkTimeoutError",
      path: "/ilink/bot/sendmessage",
      timeoutMs: DEFAULT_SEND_TIMEOUT_MS,
    });
  });

  it("keeps getUpdates on its independent long-poll timeout path", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const client = new ILinkClient("https://example.com", "tok");
    const poll = client.getUpdates("cursor", "1.0.2", 1_000);
    const result = expect(poll).resolves.toEqual({
      ret: 0,
      msgs: [],
      get_updates_buf: "cursor",
    });

    // getUpdates retains its existing timeoutMs + 5s abort allowance and is
    // not converted into the ordinary-send ILinkTimeoutError.
    await vi.advanceTimersByTimeAsync(6_000);
    await result;
  });

  it("throws with code/errmsg when iLink rejects at the application layer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ errcode: 10008, errmsg: "request rejected" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).rejects.toThrow(
      /code=10008.*request rejected/,
    );

    vi.restoreAllMocks();
  });

  it("retries exactly once without context_token for token-bound -2 prepare failed", async () => {
    const requestBodies: Array<{ msg: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_url, init) => {
        requestBodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ errcode: 0, ret: -2, errmsg: "prepare failed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
      .mockImplementationOnce(async (_url, init) => {
        requestBodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ ret: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).resolves.toBeUndefined();

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.msg.context_token).toBe("ctx");
    expect(requestBodies[1]?.msg).not.toHaveProperty("context_token");
    expect(requestBodies[1]?.msg.client_id).toBe(requestBodies[0]?.msg.client_id);
    expect(requestBodies[1]?.msg.item_list).toEqual(requestBodies[0]?.msg.item_list);
  });

  it("does not retry tokenless -2 prepare failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: -2, errmsg: "prepare failed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    const error = await client.sendText("peer1", "hello").catch((err) => err);
    expect(error).toMatchObject({ code: -2, upstreamMessage: "prepare failed" });
    expect(isTokenlessFallbackFailure(error)).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    { response: { ret: -2, errmsg: "rate limit" }, label: "rate limit" },
    { response: { ret: -2, errmsg: "message too long" }, label: "oversize" },
    { response: { ret: -2, errmsg: "Prepare failed" }, label: "different case" },
    { response: { ret: -2, errmsg: "prepare failed " }, label: "trailing whitespace" },
    { response: { ret: 429, errmsg: "prepare failed" }, label: "other code" },
  ])("does not blanket-fallback for $label errors", async ({ response }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).rejects.toBeInstanceOf(
      ILinkSendError,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("throws the real tokenless retry error when fallback also fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const requestBodies: Array<{ msg: { client_id: string } }> = [];
    const responses = [
      { ret: -2, errmsg: "prepare failed" },
      { ret: 10008, errmsg: "request rejected" },
      { ret: 0 },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) => {
        requestBodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const client = new ILinkClient("https://example.com", "tok");
    const error = await client.sendText("peer1", "hello", "ctx").catch((err) => err);
    expect(error).toMatchObject({
      code: 10008,
      upstreamMessage: "request rejected",
    });
    expect(isTokenlessFallbackFailure(error)).toBe(true);
    await expect(
      client.sendText(
        "peer1",
        "hello",
        "fresh-context",
        error.tokenlessFallbackClientId,
      ),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(new Set(requestBodies.map(({ msg }) => msg.client_id)).size).toBe(1);
  });

  it("preserves and marks a tokenless retry transport error", async () => {
    const transportError = new Error("tokenless network failure");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: -2, errmsg: "prepare failed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(transportError);

    const client = new ILinkClient("https://example.com", "tok");
    const error = await client.sendText("peer1", "hello", "ctx").catch((err) => err);

    expect(error).toBe(transportError);
    expect(isTokenlessFallbackFailure(error)).toBe(true);
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

  it("does not let errcode=0 mask a non-zero ret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 0, ret: -2, errmsg: "rate limit" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ILinkClient("https://example.com", "tok");
    await expect(client.sendText("peer1", "hello", "ctx")).rejects.toMatchObject({
      code: -2,
    });
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
