import type { Processor, ProcessorResponse } from "../types.js";

export class HttpProcessor implements Processor {
  readonly name: string;
  private url: string;
  private timeoutMs: number;

  constructor(name: string, url: string, timeoutMs = 120_000) {
    this.name = name;
    this.url = url.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async send(message: string, chatId: string): Promise<ProcessorResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, chat_id: chatId }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          text: `HTTP ${res.status}: ${body.slice(0, 200)}`,
          error: true,
        };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const text =
        typeof data.reply === "string"
          ? data.reply
          : typeof data.text === "string"
            ? data.text
            : typeof data.message === "string"
              ? data.message
              : JSON.stringify(data);

      return { text };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { text: `请求超时 (${this.timeoutMs / 1000}s)`, error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `请求失败: ${msg}`, error: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async clearSession(_chatId: string): Promise<void> {
    // HTTP processors are typically stateless on Wegate side;
    // session management is delegated to the backend service.
  }
}
