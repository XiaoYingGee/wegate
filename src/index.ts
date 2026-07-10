import { resolve } from "node:path";
import { ILinkClient } from "./client/ilink.js";
import { SessionStore } from "./store/session.js";
import { Router } from "./router.js";
import { ClaudeCodeProcessor } from "./processors/claude.js";
import { HttpProcessor } from "./processors/http.js";
import { ensureLogin, startMessageLoop } from "./bridge.js";
import { startApiServer } from "./api.js";
import { loadConfig } from "./config.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[wegate] ${msg}`, ...args);
const logError = (msg: string, ...args: unknown[]) =>
  console.error(`[wegate] ${msg}`, ...args);

async function main(): Promise<void> {
  const config = loadConfig();
  const sessionPath = resolve(config.dataDir, "session.json");

  const store = new SessionStore(sessionPath);
  const client = new ILinkClient();
  const router = new Router();

  // 1. Login
  await ensureLogin(client, store);

  // 2. Register processors
  for (const pc of config.processors) {
    if (pc.type === "claude") {
      router.registerProcessor(new ClaudeCodeProcessor(pc.command, pc.name), {
        prefix: pc.prefix,
        isDefault: pc.default,
      });
    } else if (pc.type === "http") {
      router.registerProcessor(new HttpProcessor(pc.name, pc.url), {
        prefix: pc.prefix,
        isDefault: pc.default,
      });
    }
  }

  log(`已注册 ${router.listProcessors().length} 个处理器: ${router.listProcessors().join(", ")}`);

  // 3. Start API server
  const server = startApiServer({ client, store, router }, config.apiHost, config.apiPort);

  // 4. Graceful shutdown
  const shutdown = async () => {
    log("正在关闭...");
    server.close();
    await router.dispose();
    await store.save();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // 5. Start message loop
  startMessageLoop(client, store, async (from, text) => {
    log(`← [${from}] ${text}`);

    const parsed = router.parse(text);

    if (parsed.type === "command") {
      await handleCommand(parsed.command!, parsed.args || "", from, client, store, router);
      return;
    }

    const processor = router.resolve(from, parsed);
    if (!processor) {
      await reply(client, store, from, "没有可用的处理器。");
      return;
    }

    const msgText = parsed.text;
    if (!msgText) {
      const active = router.getActive(from);
      await reply(client, store, from, `已切换到 ${active}`);
      return;
    }

    log(`→ [${processor.name}] ${msgText.slice(0, 50)}...`);
    const resp = await processor.send(msgText, from);
    const tag = `[${processor.name}] `;
    await reply(client, store, from, tag + resp.text);
    if (resp.error) {
      logError(`[${processor.name}] 处理错误: ${resp.text}`);
    }
  }).catch((err) => {
    logError("消息循环异常退出:", err);
    process.exit(1);
  });

  log("Wegate 已启动，等待微信消息...");

  // Keep alive
  await new Promise(() => {});
}

async function handleCommand(
  command: string,
  args: string,
  chatId: string,
  client: ILinkClient,
  store: SessionStore,
  router: Router,
): Promise<void> {
  switch (command) {
    case "help": {
      const lines = [
        "Wegate 命令（#号开头，后接空格）:",
        "  #help — 显示此帮助",
        "  #status — 当前状态",
        "  #claude — 切回 Claude Code",
        "  #clear — 重置当前处理器的会话",
        ...Array.from(new Set(router.listProcessors()))
          .filter((n) => n !== "claude")
          .map((n) => `  #${n} <消息> — 切换到 ${n}`),
      ];
      await reply(client, store, chatId, lines.join("\n"));
      break;
    }

    case "status": {
      const active = router.getActive(chatId);
      const procs = router.listProcessors().join(", ");
      await reply(
        client,
        store,
        chatId,
        `当前处理器: ${active}\n可用: ${procs}\n连接: ${store.isLoggedIn ? "正常" : "断开"}`,
      );
      break;
    }

    case "claude": {
      if (router.switchTo(chatId, "claude")) {
        await reply(client, store, chatId, "已切换到 Claude Code");
      } else {
        await reply(client, store, chatId, "Claude Code 处理器不可用");
      }
      break;
    }

    case "clear": {
      const active = router.getActive(chatId);
      const processor = router.getProcessor(active);
      if (processor) {
        await processor.clearSession(chatId);
        await reply(client, store, chatId, `已重置 ${active} 的会话`);
      } else {
        await reply(client, store, chatId, "没有活跃的处理器");
      }
      break;
    }

    default:
      await reply(client, store, chatId, `未知命令: /${command}`);
  }
}

async function reply(
  client: ILinkClient,
  store: SessionStore,
  to: string,
  text: string,
): Promise<void> {
  const token = store.getPeerToken(to);
  if (!token) {
    logError(`无法回复 ${to}: 没有 context_token`);
    return;
  }

  try {
    const maxLen = 2000;
    if (text.length <= maxLen) {
      await client.sendText(to, text, token);
      log(`→ [${to}] ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);
      return;
    }

    for (let i = 0; i < text.length; i += maxLen) {
      const chunk = text.slice(i, i + maxLen);
      await client.sendText(to, chunk, token);
    }
    log(`→ [${to}] (${Math.ceil(text.length / maxLen)} 条分段消息)`);
  } catch (err) {
    logError(`回复发送失败 [${to}]:`, err);
  }
}

main().catch((err) => {
  logError("启动失败:", err);
  process.exit(1);
});
