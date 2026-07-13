import { spawn, type ChildProcess } from "node:child_process";
import type { Processor, ProcessorResponse } from "../types.js";

export class ClaudeCodeProcessor implements Processor {
  readonly name: string;
  private command: string;
  private sessions = new Map<string, string>();
  private activeChildren = new Set<ChildProcess>();

  constructor(command = "claude", name = "claude") {
    this.command = command;
    this.name = name;
  }

  async send(message: string, chatId: string): Promise<ProcessorResponse> {
    const args = ["--print", "--output-format", "text"];
    const sessionId = this.sessions.get(chatId);
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push("--", message);

    try {
      const result = await this.exec(args);

      if (result.sessionId) {
        this.sessions.set(chatId, result.sessionId);
      }

      return { text: result.text || "（无回复）" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `Claude Code 错误: ${msg}`, error: true };
    }
  }

  async clearSession(chatId: string): Promise<void> {
    this.sessions.delete(chatId);
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    for (const child of this.activeChildren) {
      child.kill("SIGTERM");
    }
    this.activeChildren.clear();
  }

  private exec(
    args: string[],
  ): Promise<{ text: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
        cwd: process.env.HOME || undefined,
        env: { ...process.env },
      });

      this.activeChildren.add(child);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (err) => {
        this.activeChildren.delete(child);
        reject(err);
      });

      child.on("close", (code, signal) => {
        this.activeChildren.delete(child);
        const out = Buffer.concat(stdout).toString("utf-8").trim();
        const errOut = Buffer.concat(stderr).toString("utf-8").trim();

        if (code !== 0) {
          if (!out) {
            const detail = signal ? `执行超时或被终止 (${signal})` : errOut || `exit code ${code}`;
            reject(new Error(detail));
            return;
          }
          console.error(
            `[claude] 非零退出码 ${code}${signal ? ` signal=${signal}` : ""}: ${errOut.slice(0, 200)}`,
          );
        }

        let sessionId: string | undefined;
        const sessionMatch = errOut.match(
          /session[_\s]?id[:\s]+(\S+)/i,
        );
        if (sessionMatch) {
          sessionId = sessionMatch[1];
        }

        resolve({ text: out, sessionId });
      });
    });
  }
}
