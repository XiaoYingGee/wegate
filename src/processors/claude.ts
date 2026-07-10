import { spawn } from "node:child_process";
import type { Processor, ProcessorResponse } from "../types.js";

export class ClaudeCodeProcessor implements Processor {
  readonly name = "claude";
  private command: string;
  private sessions = new Map<string, string>();

  constructor(command = "claude") {
    this.command = command;
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
  }

  private exec(
    args: string[],
  ): Promise<{ text: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
        env: { ...process.env },
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        const out = Buffer.concat(stdout).toString("utf-8").trim();
        const errOut = Buffer.concat(stderr).toString("utf-8").trim();

        if (code !== 0 && !out) {
          reject(new Error(errOut || `exit code ${code}`));
          return;
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
