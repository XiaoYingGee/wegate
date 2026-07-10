export interface InboundMessage {
  from: string;
  text: string;
  raw?: unknown;
}

export interface ProcessorResponse {
  text: string;
  error?: boolean;
}

export interface Processor {
  readonly name: string;
  send(message: string, chatId: string): Promise<ProcessorResponse>;
  clearSession(chatId: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface ProcessorConfig {
  name: string;
  type: "claude" | "http";
  command?: string;
  prefix?: string;
  url?: string;
  default?: boolean;
}

export interface RouteResult {
  type: "command" | "message";
  command?: string;
  args?: string;
  processor?: string;
  text?: string;
}

export interface WegateConfig {
  dataDir: string;
  processors: ProcessorConfig[];
  apiPort: number;
  apiHost: string;
}

export function loadConfig(): WegateConfig {
  const dataDir = process.env.WEGATE_DATA_DIR || "./data";
  const apiPort = parseInt(process.env.WEGATE_API_PORT || "9800", 10);
  const apiHost = process.env.WEGATE_API_HOST || "127.0.0.1";

  const processors: ProcessorConfig[] = [];

  processors.push({
    name: "claude",
    type: "claude",
    command: process.env.WEGATE_CLAUDE_CMD || "claude",
    default: true,
  });

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
