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

export type ProcessorConfig =
  | { type: "claude"; name: string; command?: string; cwd?: string; prefix?: string; default?: boolean }
  | { type: "http"; name: string; url: string; prefix?: string; default?: boolean };

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
