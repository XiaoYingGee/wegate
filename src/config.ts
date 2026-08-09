import { existsSync, statSync } from "node:fs";
import type { ProcessorConfig, WegateConfig } from "./types.js";

export function loadConfig(): WegateConfig {
  const dataDir = process.env.WEGATE_DATA_DIR || "./data";
  const apiHost = process.env.WEGATE_API_HOST || "127.0.0.1";

  const apiPort = parseInt(process.env.WEGATE_API_PORT || "9800", 10);
  if (Number.isNaN(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`无效的 WEGATE_API_PORT: ${process.env.WEGATE_API_PORT}`);
  }

  const apiToken = getApiToken();
  if (apiHost !== "127.0.0.1" && apiHost !== "localhost") {
    if (apiToken) {
      console.warn(
        `[wegate] 警告: API 绑定到 ${apiHost}（非本地地址），已启用 WEGATE_API_TOKEN 鉴权，` +
          `但仍建议仅在受信任网络/HTTPS 反向代理后暴露，避免 token 被窃听`,
      );
    } else {
      console.warn(
        `[wegate] 严重警告: API 绑定到 ${apiHost}（非本地地址），且未设置 WEGATE_API_TOKEN，` +
          `/api/send 和 /api/status 完全没有鉴权保护 —— 任何能访问该地址的人都可以冒充你收发微信消息。` +
          `强烈建议设置 WEGATE_API_TOKEN 或将 WEGATE_API_HOST 绑定回 127.0.0.1`,
      );
    }
  }

  const claudeCwd = getClaudeCwd();
  const allowedSenders = getAllowedSenders();
  if (!allowedSenders) {
    console.warn(
      "[wegate] 警告: 未设置 WEGATE_ALLOWED_SENDERS，任何加了这个微信账号的联系人发消息" +
        `都可以直接驱动本机 CLI 处理器（以 ${claudeCwd || "$HOME"} 为默认工作目录、继承完整环境变量执行）。` +
        "强烈建议设置发送者白名单",
    );
  }

  const processors: ProcessorConfig[] = [];

  if (process.env.WEGATE_ENABLE_CLAUDE !== "false") {
    processors.push({
      name: "claude",
      type: "claude",
      command: process.env.WEGATE_CLAUDE_CMD || "claude",
      cwd: claudeCwd,
      default: true,
    });
  }

  if (process.env.WEGATE_ENABLE_CODEX !== "false") {
    const codexCwd = getCodexCwd();
    processors.push({
      name: "codex",
      type: "codex",
      command: process.env.WEGATE_CODEX_CMD || "/usr/bin/codex",
      cwd: codexCwd,
      prefix: "#codex",
    });
  }

  if (process.env.WEGATE_ASSET_URL) {
    processors.push({
      name: "asset",
      type: "http",
      prefix: "#asset",
      url: process.env.WEGATE_ASSET_URL,
    });
  }

  const extraProcessors = process.env.WEGATE_PROCESSORS;
  if (extraProcessors) {
    try {
      const parsed = JSON.parse(extraProcessors) as ProcessorConfig[];
      processors.push(...parsed);
    } catch {
      console.error("[wegate] WEGATE_PROCESSORS JSON 解析失败，已忽略");
    }
  }

  return { dataDir, processors, apiPort, apiHost };
}

/**
 * Optional shared-secret for /api/send and /api/status. When set, requests
 * must include a matching `Authorization: Bearer <token>` header.
 */
export function getApiToken(): string | undefined {
  const token = process.env.WEGATE_API_TOKEN?.trim();
  return token || undefined;
}

/**
 * Optional working directory for the spawned Claude Code CLI subprocess.
 * Claude Code discovers project-level config (CLAUDE.md, .claude/skills/)
 * by walking up from its cwd, so pointing this at a specific project
 * directory lets that project's own skills load for messages routed here.
 * Falls back to $HOME (Claude Code's own default project scope) when unset
 * or when the configured path doesn't exist / isn't a directory.
 */
export function getClaudeCwd(): string | undefined {
  const raw = process.env.WEGATE_CLAUDE_CWD?.trim();
  if (!raw) return process.env.HOME || undefined;

  if (!existsSync(raw) || !statSync(raw).isDirectory()) {
    console.warn(
      `[wegate] 警告: WEGATE_CLAUDE_CWD="${raw}" 不存在或不是目录，已回退为 $HOME`,
    );
    return process.env.HOME || undefined;
  }

  return raw;
}

/** Working directory for Codex, with the same safe fallback as Claude Code. */
export function getCodexCwd(): string | undefined {
  const raw = process.env.WEGATE_CODEX_CWD?.trim();
  if (!raw) return process.env.HOME || undefined;

  if (!existsSync(raw) || !statSync(raw).isDirectory()) {
    console.warn(
      `[wegate] 警告: WEGATE_CODEX_CWD="${raw}" 不存在或不是目录，已回退为 $HOME`,
    );
    return process.env.HOME || undefined;
  }
  return raw;
}

/**
 * Optional whitelist of WeChat contact IDs allowed to drive processors
 * (e.g. Claude Code). Comma-separated. When unset, any contact is allowed.
 */
export function getAllowedSenders(): string[] | undefined {
  const raw = process.env.WEGATE_ALLOWED_SENDERS;
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}
