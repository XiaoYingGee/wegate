import { spawn, type ChildProcess } from "node:child_process";
import type { Processor, ProcessorResponse } from "../types.js";

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  message?: string;
  error?: { message?: string };
}

interface ParsedCodexOutput {
  text: string;
  sessionId?: string;
  error?: string;
}

const SIGKILL_GRACE_MS = 4_000;

/** Parse Codex `exec --json` JSONL events, keeping the last agent reply. */
function parseCodexJsonLines(raw: string): ParsedCodexOutput {
  let sessionId: string | undefined;
  let text = "";
  let error: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as CodexEvent;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        text = event.item.text;
      }
      if (
        (event.type === "turn.failed" || event.type === "error") &&
        typeof (event.error?.message || event.message) === "string"
      ) {
        error = event.error?.message || event.message;
      }
    } catch {
      // A killed process can leave a truncated final JSONL line; retain parsed events.
    }
  }

  return { text, sessionId, error };
}

export class CodexProcessor implements Processor {
  readonly name: string;
  private command: string;
  private cwd?: string;
  private sessions = new Map<string, string>();
  private activeChildren = new Set<ChildProcess>();
  private terminationPromises = new Map<ChildProcess, Promise<void>>();

  constructor(command = "codex", name = "codex", cwd?: string) {
    this.command = command;
    this.name = name;
    this.cwd = cwd;
  }

  async send(message: string, chatId: string): Promise<ProcessorResponse> {
    const sessionId = this.sessions.get(chatId);
    const args = sessionId
      ? ["exec", "resume", sessionId, "--json", message]
      : ["exec", "--json", "--sandbox", "workspace-write", message];

    try {
      const result = await this.exec(args);
      if (result.sessionId) this.sessions.set(chatId, result.sessionId);
      return { text: result.text || "（无回复）" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `Codex 错误: ${msg}`, error: true };
    }
  }

  async clearSession(chatId: string): Promise<void> {
    this.sessions.delete(chatId);
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    const children = Array.from(this.activeChildren);
    this.activeChildren.clear();
    await Promise.all(children.map((child) => this.terminate(child)));
  }

  private terminate(child: ChildProcess, graceMs = SIGKILL_GRACE_MS): Promise<void> {
    const existing = this.terminationPromises.get(child);
    if (existing) return existing;

    const termination = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.terminationPromises.delete(child);
        resolve();
      };
      child.once("exit", finish);
      child.once("close", finish);
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          this.signalProcessGroup(child, "SIGKILL");
        } catch {
          // Process may have exited between the state check and kill.
        }
      }, graceMs);
      try {
        this.signalProcessGroup(child, "SIGTERM");
      } catch {
        finish();
      }
    });
    this.terminationPromises.set(child, termination);
    return termination;
  }

  /** Codex is a Node wrapper; signal its whole Linux process group, not just the wrapper. */
  private signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform === "linux" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  }

  private exec(args: string[]): Promise<ParsedCodexOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform === "linux",
        cwd: this.cwd || process.env.HOME || undefined,
        env: { ...process.env },
      });
      this.activeChildren.add(child);
      const timeout = setTimeout(() => void this.terminate(child), 600_000);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (err) => {
        clearTimeout(timeout);
        this.activeChildren.delete(child);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        this.activeChildren.delete(child);
        const out = Buffer.concat(stdout).toString("utf-8").trim();
        const errOut = Buffer.concat(stderr).toString("utf-8").trim();
        const parsed = parseCodexJsonLines(out);

        if (signal) {
          if (parsed.text) {
            resolve({
              text: `${parsed.text}\n\n[注意：Codex 执行被信号 ${signal} 中断，以上为部分输出]`,
              sessionId: parsed.sessionId,
            });
          } else {
            reject(new Error(`Codex 进程被信号 ${signal} 中断${errOut ? `: ${errOut.slice(0, 200)}` : ""}`));
          }
          return;
        }

        if (code !== 0) {
          reject(new Error(parsed.error || errOut || `exit code ${code}`));
          return;
        }
        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        resolve(parsed);
      });
    });
  }
}
