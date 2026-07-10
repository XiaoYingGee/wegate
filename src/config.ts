import type { ProcessorConfig, WegateConfig } from "./types.js";

export function loadConfig(): WegateConfig {
  const dataDir = process.env.WEGATE_DATA_DIR || "./data";
  const apiHost = process.env.WEGATE_API_HOST || "127.0.0.1";

  const apiPort = parseInt(process.env.WEGATE_API_PORT || "9800", 10);
  if (Number.isNaN(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`无效的 WEGATE_API_PORT: ${process.env.WEGATE_API_PORT}`);
  }

  if (apiHost !== "127.0.0.1" && apiHost !== "localhost") {
    console.warn(
      `[wegate] 警告: API 绑定到 ${apiHost}，无认证保护，请确保网络安全`,
    );
  }

  const processors: ProcessorConfig[] = [];

  if (process.env.WEGATE_ENABLE_CLAUDE !== "false") {
    processors.push({
      name: "claude",
      type: "claude",
      command: process.env.WEGATE_CLAUDE_CMD || "claude",
      default: true,
    });
  }

  if (process.env.WEGATE_ASSET_URL) {
    processors.push({
      name: "asset",
      type: "http",
      prefix: "/asset",
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
