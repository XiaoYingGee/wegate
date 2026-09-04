import { randomBytes, randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_SEND_TIMEOUT_MS = 15_000;

const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

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

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/**
 * iLink can return HTTP 200 while rejecting the message at the protocol layer.
 * Keep the numeric code machine-readable for diagnostics. The official
 * client treats any non-zero `ret` as an upstream send failure. Wegate only
 * applies its narrowly-scoped tokenless fallback inside `sendText`.
 */
export class ILinkSendError extends Error {
  readonly code: number;
  readonly upstreamMessage: string;

  constructor(code: number, upstreamMessage?: string) {
    const detail = upstreamMessage || "unknown";
    super(`sendmessage 业务层失败: code=${code} errmsg=${detail}`);
    this.name = "ILinkSendError";
    this.code = code;
    this.upstreamMessage = detail;
  }
}

export class ILinkTimeoutError extends Error {
  readonly path: string;
  readonly timeoutMs: number;

  constructor(path: string, timeoutMs: number) {
    super(`${path} timeout after ${timeoutMs}ms`);
    this.name = "ILinkTimeoutError";
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

export type TokenlessFallbackFailure = Error & {
  tokenlessFallbackAttempted: true;
  tokenlessFallbackClientId: string;
};

/** Whether this is the original error thrown by a failed tokenless retry. */
export function isTokenlessFallbackFailure(
  err: unknown,
): err is TokenlessFallbackFailure {
  return (
    err instanceof Error &&
    (err as TokenlessFallbackFailure).tokenlessFallbackAttempted === true
  );
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
    contextToken?: string,
    stableClientID?: string,
  ): Promise<void> {
    // 微信客户端不识别 \n/\r\n 作为换行（实测挤成一行），
    // U+2028 (LINE SEPARATOR) 是实测唯一能在手机/电脑微信都正确换行的编码。
    const wechatText = text.replace(/\r\n|\r|\n/g, " ");
    const clientID = stableClientID || `wegate-${randomUUID()}`;
    const send = (token?: string) =>
      this.postJSON<SendMessageResponse>(
        "/ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: toUserID,
            client_id: clientID,
            message_type: 2,
            message_state: 2,
            context_token: token || undefined,
            item_list: [{ type: 1, text_item: { text: wechatText } }],
          },
        },
        undefined,
        DEFAULT_SEND_TIMEOUT_MS,
      );

    let resp = await send(contextToken);
    let businessCode = getSendBusinessCode(resp);
    let tokenlessFallbackAttempted = false;

    // A context_token can remain persisted after iLink no longer accepts it.
    // Hermes confirmed that the same message succeeds tokenless in this exact
    // upstream state. Retry once without changing the idempotency client_id.
    if (
      contextToken &&
      businessCode === -2 &&
      resp.errmsg === "prepare failed"
    ) {
      tokenlessFallbackAttempted = true;
      try {
        resp = await send();
      } catch (err) {
        markTokenlessFallbackFailure(err, clientID);
      }
      businessCode = getSendBusinessCode(resp);
    }

    // Some iLink variants return both fields (for example errcode=0 with a
    // non-zero ret). Any non-zero business code must win over a zero alias.
    if (businessCode) {
      logError(
        `sendmessage 被 iLink 拒绝: code=${businessCode} to=${toUserID}`,
      );
      const error = new ILinkSendError(businessCode, resp.errmsg);
      if (tokenlessFallbackAttempted) {
        markTokenlessFallbackFailure(error, clientID);
      }
      throw error;
    }
  }

  // ── Internal ──

  private async postJSON<T = unknown>(
    path: string,
    payload: unknown,
    externalSignal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    const bodyBytes = JSON.stringify(payload);
    const headers = this.buildHeaders(bodyBytes);
    const controller = timeoutMs !== undefined ? new AbortController() : undefined;
    let timedOut = false;
    const onExternalAbort = () => controller?.abort();
    if (externalSignal && controller) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const signal = controller?.signal ?? externalSignal;
    const timer = controller && timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

    try {
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
    } catch (err) {
      if (timedOut && timeoutMs !== undefined && isAbortError(err)) {
        throw new ILinkTimeoutError(path, timeoutMs);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
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

function getSendBusinessCode(resp: SendMessageResponse): number | undefined {
  return (
    (resp.errcode !== undefined && resp.errcode !== 0 ? resp.errcode : undefined) ??
    (resp.ret !== undefined && resp.ret !== 0 ? resp.ret : undefined) ??
    resp.errcode ??
    resp.ret
  );
}

function markTokenlessFallbackFailure(err: unknown, clientID: string): never {
  if (err instanceof Error) {
    Object.defineProperty(err, "tokenlessFallbackAttempted", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(err, "tokenlessFallbackClientId", {
      value: clientID,
      configurable: true,
    });
  }
  throw err;
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
