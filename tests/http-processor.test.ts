import { describe, it, expect, vi } from "vitest";
import { HttpProcessor } from "../src/processors/http.js";

describe("HttpProcessor", () => {
  it("sends message and returns reply", async () => {
    const mockResponse = { reply: "资产总计 100 万" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const processor = new HttpProcessor("asset", "http://localhost:8080/ai/chat");
    const result = await processor.send("查查我的资产", "user1");

    expect(result.text).toBe("资产总计 100 万");
    expect(result.error).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("handles HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const processor = new HttpProcessor("asset", "http://localhost:8080/ai/chat");
    const result = await processor.send("test", "user1");

    expect(result.error).toBe(true);
    expect(result.text).toContain("500");

    vi.restoreAllMocks();
  });

  it("handles network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    const processor = new HttpProcessor("asset", "http://localhost:8080/ai/chat");
    const result = await processor.send("test", "user1");

    expect(result.error).toBe(true);
    expect(result.text).toContain("ECONNREFUSED");

    vi.restoreAllMocks();
  });

  it("extracts text from various response shapes", async () => {
    for (const [body, expected] of [
      [{ reply: "from reply" }, "from reply"],
      [{ text: "from text" }, "from text"],
      [{ message: "from message" }, "from message"],
      [{ data: 42 }, '{"data":42}'],
    ] as const) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const processor = new HttpProcessor("test", "http://localhost/api");
      const result = await processor.send("msg", "user1");
      expect(result.text).toBe(expected);

      vi.restoreAllMocks();
    }
  });

  it("clearSession is a no-op", async () => {
    const processor = new HttpProcessor("asset", "http://localhost/api");
    await expect(processor.clearSession("user1")).resolves.toBeUndefined();
  });
});
