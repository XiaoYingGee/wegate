import { createInterface } from "node:readline";
import { resolve } from "node:path";
import qrcodeTerminal from "qrcode-terminal";
import { ILinkClient } from "./client/ilink.js";
import { SessionStore } from "./store/session.js";
import type { WeixinMessage } from "./client/ilink.js";

const DATA_DIR = process.env.WEGATE_DATA_DIR || "./data";
const SESSION_PATH = resolve(DATA_DIR, "session.json");

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[wegate] ${msg}`, ...args);
const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

// ── Login ──

async function login(client: ILinkClient, store: SessionStore): Promise<void> {
  log("正在获取登录二维码...");
  const qr = await client.fetchLoginQRCode();

  // Display QR code in terminal
  if (qr.qrcode_img_content) {
    qrcodeTerminal.generate(qr.qrcode_img_content, { small: true }, (code: string) => {
      console.log(code);
    });
  } else if (qr.qrcode) {
    qrcodeTerminal.generate(qr.qrcode, { small: true }, (code: string) => {
      console.log(code);
    });
  }
  log("请用微信扫描上方二维码登录");

  // Poll for login confirmation
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await client.pollLoginStatus(qr.qrcode);

    switch (status.status) {
      case "scaned":
        log("已扫码，请在手机上确认登录...");
        break;
      case "confirmed":
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error("登录确认但缺少 token 或 bot_id");
        }
        const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";
        client.setToken(status.bot_token);
        client.setBaseURL(baseUrl);
        store.setLogin(
          status.bot_token,
          status.ilink_bot_id,
          status.ilink_user_id,
          baseUrl,
        );
        await store.save();
        log(`登录成功! bot_id=${status.ilink_bot_id}`);
        return;
      case "expired":
        throw new Error("二维码已过期，请重新运行登录");
      case "wait":
        break;
    }

    await sleep(1000);
  }

  throw new Error("登录超时");
}

// ── Message Loop ──

async function messageLoop(
  client: ILinkClient,
  store: SessionStore,
  onMessage: (msg: WeixinMessage) => void,
): Promise<void> {
  let timeoutMs = 35_000;

  while (true) {
    try {
      const resp = await client.getUpdates(
        store.session.get_updates_buf,
        "1.0.2",
        timeoutMs,
      );

      if (resp.errcode) {
        logError(
          `getUpdates 错误: errcode=${resp.errcode} errmsg=${resp.errmsg}`,
        );
        await sleep(5000);
        continue;
      }

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms;
      }

      const newBuf = resp.get_updates_buf || resp.sync_buf;
      if (newBuf && newBuf !== store.session.get_updates_buf) {
        store.setUpdatesBuf(newBuf);
        await store.save();
      }

      if (resp.msgs) {
        for (const msg of resp.msgs) {
          const from = msg.from_user_id?.trim();
          if (!from) continue;

          store.upsertPeer(from, msg.context_token?.trim());
          await store.save();

          onMessage(msg);
        }
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

// ── Interactive CLI ──

async function interactiveLoop(
  client: ILinkClient,
  store: SessionStore,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    const peer = store.currentPeer || "无";
    rl.setPrompt(`[${peer}] > `);
    rl.prompt();
  };

  log("聊天模式已启动。命令: /help /users /use <peer> /send <peer> <msg> /quit");
  prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    try {
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, client, store);
      } else {
        await sendToCurrent(client, store, trimmed);
      }
    } catch (err) {
      logError("操作失败:", err);
    }
    prompt();
  });

  rl.on("close", () => {
    log("退出");
    process.exit(0);
  });
}

async function handleCommand(
  line: string,
  client: ILinkClient,
  store: SessionStore,
): Promise<void> {
  const parts = line.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case "/help":
      log("命令列表:");
      log("  /users           列出已知联系人");
      log("  /who             当前选中联系人");
      log("  /use <peer>      切换联系人");
      log("  /send <peer> <m> 给指定联系人发消息");
      log("  /quit            退出");
      break;

    case "/users": {
      const peers = store.listPeers();
      if (peers.length === 0) {
        log("暂无已知联系人，等待对方先发一条消息");
      } else {
        log(`已知联系人 (${peers.length}):`);
        for (const p of peers) {
          const hasToken = store.getPeerToken(p) ? "✓" : "✗";
          log(`  ${p} [token: ${hasToken}]`);
        }
      }
      break;
    }

    case "/who":
      log(`当前联系人: ${store.currentPeer || "未选择"}`);
      break;

    case "/use":
      if (!parts[1]) {
        log("用法: /use <peer_id>");
        return;
      }
      if (!store.getPeerToken(parts[1])) {
        log(`联系人 ${parts[1]} 没有 context_token，无法发消息`);
        return;
      }
      store.currentPeer = parts[1];
      await store.save();
      log(`已切换到: ${parts[1]}`);
      break;

    case "/send": {
      if (parts.length < 3) {
        log("用法: /send <peer_id> <message>");
        return;
      }
      const peer = parts[1];
      const text = parts.slice(2).join(" ");
      const token = store.getPeerToken(peer);
      if (!token) {
        log(`联系人 ${peer} 没有 context_token`);
        return;
      }
      await client.sendText(peer, text, token);
      log(`已发送给 ${peer}: ${text}`);
      break;
    }

    case "/quit":
    case "/exit":
      process.exit(0);

    default:
      log(`未知命令: ${cmd}，输入 /help 查看帮助`);
  }
}

async function sendToCurrent(
  client: ILinkClient,
  store: SessionStore,
  text: string,
): Promise<void> {
  const peer = store.currentPeer;
  if (!peer) {
    log("没有选中联系人，等对方先发一条消息，或用 /use <peer>");
    return;
  }
  const token = store.getPeerToken(peer);
  if (!token) {
    log(`联系人 ${peer} 没有 context_token`);
    return;
  }
  await client.sendText(peer, text, token);
  log(`→ ${text}`);
}

// ── Main ──

async function main(): Promise<void> {
  const store = new SessionStore(SESSION_PATH);
  const hasSession = await store.load();

  const client = new ILinkClient(
    hasSession ? store.session.base_url : undefined,
    hasSession ? store.session.bot_token : undefined,
  );

  if (!hasSession) {
    await login(client, store);
  } else {
    log(`已恢复 session: bot_id=${store.session.bot_id}`);
  }

  // Start message polling in background
  messageLoop(client, store, (msg) => {
    const from = msg.from_user_id || "unknown";
    const text = extractText(msg);
    log(`← [${from}] ${text}`);
  }).catch((err) => {
    logError("消息循环异常退出:", err);
    process.exit(1);
  });

  // Start interactive CLI
  await interactiveLoop(client, store);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logError("启动失败:", err);
  process.exit(1);
});
