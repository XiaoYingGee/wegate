import type { Processor, RouteResult } from "./types.js";

const BUILTIN_COMMANDS = new Set(["clear", "claude", "help", "status"]);

// Matches: optional leading whitespace, #word, then at least one whitespace or end of string.
// Captures: (1) command name, (2) remaining text after the whitespace (may be empty/undefined).
// Rules:
//   - No non-whitespace characters before #
//   - # must be immediately followed by letters (no space)
//   - At least one space or newline after #word to be valid
//   - #word at end of string without trailing space is NOT a command (treated as plain text)
const HASH_CMD_RE = /^\s*#([a-zA-Z]\w*)(?:\s+([\s\S]*)|\s+)$/;

export class Router {
  private processors = new Map<string, Processor>();
  private prefixMap = new Map<string, string>();
  private defaultName: string | undefined;
  private activeProcessor = new Map<string, string>();

  registerProcessor(
    processor: Processor,
    opts?: { prefix?: string; isDefault?: boolean },
  ) {
    this.processors.set(processor.name, processor);
    if (opts?.prefix) {
      const normalized = opts.prefix.replace(/^#/, "").toLowerCase();
      this.prefixMap.set(normalized, processor.name);
    }
    if (opts?.isDefault) {
      this.defaultName = processor.name;
    }
  }

  parse(text: string): RouteResult {
    const match = text.match(HASH_CMD_RE);
    if (match) {
      const name = match[1].toLowerCase();
      const body = match[2]?.trim() || undefined;

      if (BUILTIN_COMMANDS.has(name)) {
        return { type: "command", command: name, args: body || "" };
      }

      if (this.prefixMap.has(name)) {
        return {
          type: "message",
          processor: this.prefixMap.get(name)!,
          text: body,
        };
      }
    }

    return { type: "message", text: text.trim() };
  }

  resolve(chatId: string, parsed: RouteResult): Processor | undefined {
    if (parsed.processor) {
      this.activeProcessor.set(chatId, parsed.processor);
      return this.processors.get(parsed.processor);
    }

    const active = this.activeProcessor.get(chatId);
    if (active) {
      return this.processors.get(active);
    }

    if (this.defaultName) {
      return this.processors.get(this.defaultName);
    }

    return undefined;
  }

  switchTo(chatId: string, processorName: string): boolean {
    if (!this.processors.has(processorName)) return false;
    this.activeProcessor.set(chatId, processorName);
    return true;
  }

  getActive(chatId: string): string {
    return this.activeProcessor.get(chatId) || this.defaultName || "none";
  }

  getProcessor(name: string): Processor | undefined {
    return this.processors.get(name);
  }

  listProcessors(): string[] {
    return Array.from(this.processors.keys());
  }

  async dispose(): Promise<void> {
    for (const p of this.processors.values()) {
      await p.dispose?.();
    }
  }
}
