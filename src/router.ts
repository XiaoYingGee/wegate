import type { Processor, RouteResult } from "./types.js";

const BUILTIN_COMMANDS = new Set(["clear", "claude", "help", "status"]);

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
      this.prefixMap.set(opts.prefix.toLowerCase(), processor.name);
    }
    if (opts?.isDefault) {
      this.defaultName = processor.name;
    }
  }

  parse(text: string): RouteResult {
    const trimmed = text.trim();

    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx))
        .toLowerCase();
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (BUILTIN_COMMANDS.has(cmd.slice(1))) {
        return { type: "command", command: cmd.slice(1), args };
      }

      if (this.prefixMap.has(cmd)) {
        const processorName = this.prefixMap.get(cmd)!;
        return {
          type: "message",
          processor: processorName,
          text: args || undefined,
        };
      }
    }

    return { type: "message", text: trimmed };
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
