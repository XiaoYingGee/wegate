import { randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

// ── Types ──

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token: string;
  ilink_bot_id: string;
  baseurl: string;
  ilink_user_id: string;
}

export interface MessageItem {
  type: number; // 1=text 2=image 3=voice 4=file 5=video
  text_item?: { text: string };
  voice_item?: { text?: string };
  image_item?: unknown;
  file_item?: unknown;
  video_item?: unknown;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: MessageItem[];
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  sync_buf?: string;
  longpolling_timeout_ms?: number;
}

// ── Client ──

export class ILinkClient {
  private baseURL: string;
  private token: string;

  constructor(baseURL?: string, token?: string) {
    this.baseURL = (baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = token || "";
  }

  setToken(token: string) {
    this.token = token;
  }

  setBaseURL(url: string) {
    this.baseURL = url.replace(/\/+$/, "");
  }

  async fetchLoginQRCode(botType = "3"): Promise<QRCodeResponse> {
    const url = `${this.baseURL}/ilink/bot/get_bot_qrcode?bot_type=${botType}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
    return (await res.json()) as QRCodeResponse;
  }

  async pollLoginStatus(qrcode: string): Promise<QRStatusResponse> {
    const url = `${this.baseURL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`;
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
    });
    if (!res.ok) throw new Error(`get_qrcode_status HTTP ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  }

  async getUpdates(
    buf: string,
    channelVersion = "1.0.2",
    timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
  ): Promise<GetUpdatesResponse> {
    const body = {
      get_updates_buf: buf,
      base_info: { channel_version: channelVersion },
    };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs + 5000,
    );

    try {
      return await this.postJSON<GetUpdatesResponse>(
        "/ilink/bot/getupdates",
        body,
        controller.signal,
      );
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return { ret: 0, msgs: [], get_updates_buf: buf };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendText(
    toUserID: string,
    text: string,
    contextToken: string,
  ): Promise<void> {
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: toUserID,
        client_id: `wegate-${Date.now()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    };

    await this.postJSON("/ilink/bot/sendmessage", body);
  }

  // ── Internal ──

  private async postJSON<T = unknown>(
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const bodyBytes = JSON.stringify(payload);
    const headers = this.buildHeaders(bodyBytes);

    const res = await fetch(`${this.baseURL}${path}`, {
      method: "POST",
      headers,
      body: bodyBytes,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} HTTP ${res.status}: ${text}`);
    }

    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private buildHeaders(body: string): Record<string, string> {
    const uin = randomWechatUIN();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-WECHAT-UIN": uin,
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }
}

function randomWechatUIN(): string {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0);
  return Buffer.from(String(num)).toString("base64");
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError" ||
    (err instanceof Error && err.message.includes("abort"))
  );
}
