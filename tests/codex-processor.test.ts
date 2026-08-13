import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { CodexProcessor } from "../src/processors/codex.js";

class FakeChildProcess extends EventEmitter {
  pid = 12_345;
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

function emitSuccess(child: FakeChildProcess, threadId: string, text: string) {
  child.stdout.emit(
    "data",
    Buffer.from(
      [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"),
    ),
  );
  child.emit("close", 0, null);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CodexProcessor", () => {
  it("starts a JSON execution using the user's Codex config", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);
    const processor = new CodexProcessor("/usr/bin/codex", "codex", "/work");
    const pending = processor.send("hello", "chat1");
    emitSuccess(child, "thread-123", "world");

    await expect(pending).resolves.toEqual({ text: "world" });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/codex",
      ["exec", "--skip-git-repo-check", "--json", "hello"],
      expect.objectContaining({ cwd: "/work", detached: true }),
    );
    expect(
      (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).not.toContain("--sandbox");
  });

  it("resumes the stored thread for later messages from the same chat", async () => {
    const firstChild = new FakeChildProcess();
    mockSpawn(firstChild);
    const processor = new CodexProcessor("codex");
    const first = processor.send("first", "chat1");
    emitSuccess(firstChild, "thread-123", "one");
    await first;

    const secondChild = new FakeChildProcess();
    mockSpawn(secondChild);
    const second = processor.send("second", "chat1");
    emitSuccess(secondChild, "thread-123", "two");
    await expect(second).resolves.toEqual({ text: "two" });

    expect(
      (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1],
    ).toEqual([
      "exec",
      "resume",
      "thread-123",
      "--skip-git-repo-check",
      "--json",
      "second",
    ]);
  });

  it("#clear semantics remove the stored thread", async () => {
    const firstChild = new FakeChildProcess();
    mockSpawn(firstChild);
    const processor = new CodexProcessor("codex");
    const first = processor.send("first", "chat1");
    emitSuccess(firstChild, "thread-123", "one");
    await first;
    await processor.clearSession("chat1");

    const secondChild = new FakeChildProcess();
    mockSpawn(secondChild);
    const second = processor.send("fresh", "chat1");
    emitSuccess(secondChild, "thread-456", "new");
    await second;
    expect(
      (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1],
    ).toEqual(["exec", "--skip-git-repo-check", "--json", "fresh"]);
  });

  it("returns an error when Codex exits non-zero", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);
    const pending = new CodexProcessor("codex").send("hello", "chat1");
    child.stderr.emit("data", Buffer.from("authentication failed"));
    child.emit("close", 1, null);
    await expect(pending).resolves.toEqual({
      text: "Codex 错误: authentication failed",
      error: true,
    });
  });

  it("prioritizes a structured turn.failed error over stderr on non-zero exit", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);
    const pending = new CodexProcessor("codex").send("hello", "chat1");
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "model unavailable" },
        }),
      ),
    );
    child.stderr.emit("data", Buffer.from("generic wrapper error"));
    child.emit("close", 1, null);
    await expect(pending).resolves.toEqual({
      text: "Codex 错误: model unavailable",
      error: true,
    });
  });

  it("marks output as partial when a timed-out process is interrupted", async () => {
    const child = new FakeChildProcess();
    mockSpawn(child);
    const pending = new CodexProcessor("codex").send("long", "chat1");
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ type: "thread.started", thread_id: "thread-123" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } })}`,
      ),
    );
    child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result.text).toContain("partial");
    expect(result.text).toContain("中断");
  });

  it("dispose escalates an ignored SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL")
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      });
    mockSpawn(child);
    const processor = new CodexProcessor("codex");
    const pending = processor.send("long", "chat1");
    const disposing = processor.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    await disposing;
    expect(killSpy).toHaveBeenNthCalledWith(1, -12_345, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, -12_345, "SIGKILL");
    await expect(pending).resolves.toMatchObject({ error: true });
  });

  it("on the real execution timeout signals the PGID TERM then KILL and settles send", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL")
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      });
    mockSpawn(child);

    const pending = new CodexProcessor("codex").send("hang", "chat-timeout");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(killSpy).toHaveBeenNthCalledWith(1, -12_345, "SIGTERM");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(killSpy).toHaveBeenNthCalledWith(2, -12_345, "SIGKILL");
    await expect(pending).resolves.toMatchObject({ error: true });
  });
});
