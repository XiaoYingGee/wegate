import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { ClaudeCodeProcessor } from "../src/processors/claude.js";

/** 模拟 node:child_process 的 ChildProcess，足以驱动 exec()/dispose() 的逻辑。 */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn((_signal?: string) => true);
}

function mockSpawn(child: FakeChildProcess) {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
    child as unknown as ReturnType<typeof spawn>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ClaudeCodeProcessor — BUG-8 session_id 提取", () => {
  it("以 --output-format json 调用 CLI，并从 stdout 结构化结果中解析出 session_id 与最终文本", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("hello", "chat1");

    const payload = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "world",
      session_id: "abc-123",
    });
    child.stdout.emit("data", Buffer.from(payload));
    child.emit("close", 0, null);

    const result = await pending;

    expect(result.text).toBe("world");
    expect(result.error).toBeUndefined();

    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const firstArgs = calls[calls.length - 1][1] as string[];
    expect(firstArgs).toContain("json");
    expect(firstArgs).not.toContain("text");
  });

  it("在同一 chatId 的后续调用中带上解析到的 session_id 作为 --resume 参数", async () => {
    const child1 = new FakeChildProcess();
    mockSpawn(child1);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const first = processor.send("hello", "chat1");
    child1.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ result: "world", session_id: "abc-123" })),
    );
    child1.emit("close", 0, null);
    await first;

    const child2 = new FakeChildProcess();
    mockSpawn(child2);
    const second = processor.send("again", "chat1");
    child2.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ result: "ok", session_id: "abc-123" })),
    );
    child2.emit("close", 0, null);
    await second;

    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondArgs = calls[calls.length - 1][1] as string[];
    const resumeIdx = secondArgs.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(secondArgs[resumeIdx + 1]).toBe("abc-123");
  });

  it("stdout 不是合法 JSON 时回退为原始文本，且不设置 session_id", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("hello", "chat2");
    child.stdout.emit("data", Buffer.from("纯文本回复，不是 JSON"));
    child.emit("close", 0, null);

    const result = await pending;
    expect(result.text).toBe("纯文本回复，不是 JSON");
  });

  it("传入 cwd 时，子进程以该目录作为工作目录启动（而不是硬编码 $HOME）", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude", "/some/project/dir");
    const pending = processor.send("hello", "chat-cwd");
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
    child.emit("close", 0, null);
    await pending;

    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const opts = calls[calls.length - 1][2] as { cwd?: string };
    expect(opts.cwd).toBe("/some/project/dir");
  });

  it("未传入 cwd 时，回退为 $HOME（保持向后兼容）", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("hello", "chat-cwd-default");
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
    child.emit("close", 0, null);
    await pending;

    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const opts = calls[calls.length - 1][2] as { cwd?: string };
    expect(opts.cwd).toBe(process.env.HOME || undefined);
  });
});

describe("ClaudeCodeProcessor — BUG-10 信号中断不能被当作完整成功返回", () => {
  it("被信号终止但已有部分输出时，返回文本需明确标注被中断，而不是静默当作成功结果", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("long task", "chat3");
    child.stdout.emit("data", Buffer.from("部分输出内容"));
    child.emit("close", null, "SIGTERM");

    const result = await pending;
    expect(result.text).toContain("部分输出内容");
    expect(result.text).toMatch(/中断/);
    expect(result.error).toBeUndefined();
  });

  it("被信号终止且完全没有输出时返回错误，而不是空的“成功”结果", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("long task", "chat4");
    child.emit("close", null, "SIGTERM");

    const result = await pending;
    expect(result.error).toBe(true);
    expect(result.text).toContain("Claude Code 错误");
  });
});

describe("ClaudeCodeProcessor — BUG-11 dispose() 超时升级 SIGKILL", () => {
  it("SIGTERM 后进程仍未退出时，在宽限期后升级发送 SIGKILL", async () => {
    vi.useFakeTimers();

    const child = new FakeChildProcess();
    child.kill = vi.fn((signal?: string) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      }
      // 模拟进程忽略 SIGTERM：不做任何事
      return true;
    });
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("hang forever", "chat5");

    const disposePromise = processor.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    await disposePromise;

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    // exec() 收到 close 事件后会 reject（无输出），send() 内部会捕获并返回错误结果
    const result = await pending;
    expect(result.error).toBe(true);
  });

  it("进程在宽限期内正常响应 SIGTERM 退出时，不会发送 SIGKILL", async () => {
    vi.useFakeTimers();

    const child = new FakeChildProcess();
    child.kill = vi.fn((signal?: string) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      }
      return true;
    });
    mockSpawn(child);

    const processor = new ClaudeCodeProcessor("claude", "claude");
    const pending = processor.send("quick task", "chat6");

    await processor.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await pending;
  });
});
