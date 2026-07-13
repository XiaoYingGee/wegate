import qrcodeTerminal from "qrcode-terminal";
import type { ILinkClient } from "./client/ilink.js";
import type { SessionStore } from "./store/session.js";
import type { WeixinMessage } from "./client/ilink.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[wegate] ${msg}`, ...args);
const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

export async function ensureLogin(
  client: ILinkClient,
  store: SessionStore,
): Promise<void> {
  const hasSession = await store.load();

  if (hasSession) {
    client.setToken(store.session.bot_token);
    client.setBaseURL(store.session.base_url);
    log(`已恢复 session: bot_id=${store.session.bot_id}`);
    return;
  }

  log("正在获取登录二维码...");
  const qr = await client.fetchLoginQRCode();

  const qrContent = qr.qrcode_img_content || qr.qrcode;
  if (qrContent) {
    qrcodeTerminal.generate(qrContent, { small: true }, (code: string) => {
      console.log(code);
    });
  }
  log("请用微信扫描上方二维码登录");

  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await client.pollLoginStatus(qr.qrcode);

    switch (status.status) {
      case "scaned":
        log("已扫码，请在手机上确认登录...");
        break;
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error("登录确认但缺少 token 或 bot_id");
        }
        const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";
        client.setToken(status.bot_token);
        client.setBaseURL(baseUrl);
        store.setLogin(status.bot_token, status.ilink_bot_id, status.ilink_user_id, baseUrl);
        await store.save();
        log(`登录成功! bot_id=${status.ilink_bot_id}`);
        return;
      }
      case "expired":
        throw new Error("二维码已过期，请重新运行登录");
      case "wait":
        break;
    }

    await sleep(1000);
  }

  throw new Error("登录超时");
}

export type MessageHandler = (from: string, text: string, msg: WeixinMessage) => Promise<void> | void;

/**
 * 将 key 相同的任务串行排队执行（保证同一联系人的消息按到达顺序处理），
 * 并在任务完成（无论成功或失败）后从 pending 中清理自身条目，避免
 * pending Map 随联系人数量无限增长（内存泄漏）。
 *
 * 清理时会校验 `pending.get(key) === task` 仍然成立，防止在本任务完成前
 * 又有新任务入队时，被误删新任务的条目。
 */
export function enqueueSerial(
  pending: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<void> | void,
  onError: (err: unknown) => void,
): Promise<void> {
  const prior = pending.get(key) ?? Promise.resolve();
  const task: Promise<void> = prior
    .then(() => work())
    .catch((err) => {
      onError(err);
    });
  pending.set(key, task);
  task.finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  });
  return task;
}

export async function startMessageLoop(
  client: ILinkClient,
  store: SessionStore,
  onMessage: MessageHandler,
): Promise<never> {
  let timeoutMs = 35_000;
  const pending = new Map<string, Promise<void>>();

  while (true) {
    try {
      const resp = await client.getUpdates(store.session.get_updates_buf, "1.0.2", timeoutMs);

      if (resp.errcode) {
        logError(`getUpdates 错误: errcode=${resp.errcode} errmsg=${resp.errmsg}`);
        await sleep(5000);
        continue;
      }

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms;
      }

      if (resp.msgs) {
        for (const msg of resp.msgs) {
          const from = msg.from_user_id?.trim();
          if (!from) continue;

          try {
            store.upsertPeer(from, msg.context_token?.trim());
            await store.save();

            const text = extractText(msg);
            enqueueSerial(
              pending,
              from,
              () => onMessage(from, text, msg),
              (err) => logError(`消息处理异常 [${from}]:`, err),
            );
          } catch (err) {
            logError(`消息持久化/入队异常 [${from}]，跳过该条继续处理后续消息:`, err);
          }
        }
      }

      // 游标必须在本批消息全部入队之后才推进：若在此之前崩溃，下次重启会
      // 用旧游标重新拉取整批消息（可能重复处理），而不是让游标先行、
      // 一旦崩溃就永久丢失尚未入队的消息（at-most-once → at-least-once）。
      const newBuf = resp.get_updates_buf || resp.sync_buf;
      if (newBuf && newBuf !== store.session.get_updates_buf) {
        store.setUpdatesBuf(newBuf);
        await store.save();
      }
    } catch (err) {
      logError("长轮询异常:", err);
      await sleep(5000);
    }
  }
}

function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list || []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return item.voice_item.text;
  }
  return "[非文本消息]";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
