import { spawn, type ChildProcess } from "node:child_process";
import type { Processor, ProcessorResponse } from "../types.js";

/** Claude CLI 在 --output-format json 下 stdout 输出的单个结果对象（仅列出用到的字段）。 */
interface ClaudeJsonResult {
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

/**
 * 尝试把子进程 stdout 解析为 `--output-format json` 产出的结构化结果对象，
 * 提取最终回复文本（result 字段）与真实的 session_id。
 *
 * 解析失败时返回 undefined（例如超时被信号中断导致 JSON 输出不完整，
 * 或者 stdout 本身就不是 JSON），调用方应回退为把原始 stdout 当作纯文本处理。
 */
function parseClaudeJsonResult(
  raw: string,
): { text: string; sessionId?: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as ClaudeJsonResult;
      if (typeof obj.result === "string" || typeof obj.session_id === "string") {
        return {
          text: typeof obj.result === "string" ? obj.result : "",
          sessionId:
            typeof obj.session_id === "string" ? obj.session_id : undefined,
        };
      }
    }
  } catch {
    // stdout 不是合法 JSON（例如进程被信号中断导致输出不完整），交由调用方回退处理
  }
  return undefined;
}

/** SIGTERM 后等待子进程退出的宽限期，超时则升级为 SIGKILL。 */
const SIGKILL_GRACE_MS = 4_000;

export class ClaudeCodeProcessor implements Processor {
  readonly name: string;
  private command: string;
  private cwd?: string;
  private sessions = new Map<string, string>();
  private activeChildren = new Set<ChildProcess>();

  constructor(command = "claude", name = "claude", cwd?: string) {
    this.command = command;
    this.name = name;
    this.cwd = cwd;
  }

  async send(message: string, chatId: string): Promise<ProcessorResponse> {
    // 使用 json 输出格式：CLI 会在 stdout 输出一个包含 result / session_id 的结构化对象。
    // text 格式下会话元数据不会出现在 stderr 里，之前依赖正则匹配 stderr 几乎永远拿不到
    // session_id，导致 --resume 静默失效，这里改为直接解析权威的结构化字段。
    const args = ["--print", "--output-format", "json"];
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
    const children = Array.from(this.activeChildren);
    this.activeChildren.clear();
    await Promise.all(children.map((child) => this.terminate(child)));
  }

  /**
   * 先发送 SIGTERM 请求子进程优雅退出；若在宽限期内未退出（进程忽略/挂起在 SIGTERM 上），
   * 升级为 SIGKILL 强制终止，避免服务重启/关闭时留下残留僵尸进程。
   */
  private terminate(
    child: ChildProcess,
    graceMs = SIGKILL_GRACE_MS,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      child.once("exit", finish);
      child.once("close", finish);

      const timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程可能已经在竞态中退出，忽略
        }
      }, graceMs);

      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  private exec(
    args: string[],
  ): Promise<{ text: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
        cwd: this.cwd || process.env.HOME || undefined,
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
        const parsed = parseClaudeJsonResult(out);

        if (signal) {
          // 子进程是被信号终止的（例如 timeout 选项触发的 SIGTERM），而不是正常退出。
          // 即使已经产生了部分 stdout，也不能当作完整成功结果静默返回给用户 —— 明确标记为
          // 被中断，避免调用方把截断的回复误当作完整回答。
          if (out) {
            const partialText = parsed?.text || out;
            resolve({
              text: `${partialText}\n\n[注意：Claude Code 执行被信号 ${signal} 中断，以上为部分输出]`,
              sessionId: parsed?.sessionId,
            });
            return;
          }
          reject(
            new Error(
              `Claude Code 进程被信号 ${signal} 中断${errOut ? `: ${errOut.slice(0, 200)}` : ""}`,
            ),
          );
          return;
        }

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

        resolve({ text: parsed?.text ?? out, sessionId: parsed?.sessionId });
      });
    });
  }
}
