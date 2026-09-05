import { randomUUID } from "node:crypto";
import type { SubagentRunner } from "./runner.js";
import type {
  StructuredSubagentTask,
  SubagentRunOptions,
  SubagentRunResult,
  UnsupportedSubagentOperation,
} from "./types.js";

export const DEFAULT_FORK_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_FORK_CONCURRENCY = 4;

export class StructuredSubagentScope {
  private readonly tasks = new Map<string, StructuredSubagentTask>();
  private readonly queue: Array<{
    options: SubagentRunOptions;
    task: StructuredSubagentTask;
    resolve: (result: SubagentRunResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly maxConcurrent: number;

  constructor(
    private readonly runner: SubagentRunner,
    readonly forkWaitTimeoutMs = DEFAULT_FORK_WAIT_TIMEOUT_MS,
    maxConcurrent = DEFAULT_FORK_CONCURRENCY,
  ) {
    assertTimeout(forkWaitTimeoutMs);
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  start(options: SubagentRunOptions): StructuredSubagentTask | UnsupportedSubagentOperation {
    if (options.continueAfterParentExit) return unsupportedContinueAfterParentExit();
    const id = options.taskId ?? `fork-${randomUUID()}`;
    const abortController = options.abortController ?? new AbortController();
    // fork 与后台任务同样受并发上限约束:一批 N 个 agent 调用不应同时打满
    // N 个模型请求,超出的排队等待。
    let resolve!: (result: SubagentRunResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SubagentRunResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: StructuredSubagentTask = {
      id,
      name: options.description,
      origin: options.origin,
      startedAt: new Date().toISOString(),
      status: "queued",
      usage: {},
      abortController,
      promise,
    };
    this.tasks.set(id, task);
    const entry = { options, task, resolve, reject };
    if (this.runningCount() < this.maxConcurrent) this.launch(entry);
    else this.queue.push(entry);
    return task;
  }

  private runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") count += 1;
    }
    return count;
  }

  private launch(entry: {
    options: SubagentRunOptions;
    task: StructuredSubagentTask;
    resolve: (result: SubagentRunResult) => void;
    reject: (error: unknown) => void;
  }): void {
    const { options, task, resolve, reject } = entry;
    task.status = "running";
    Promise.resolve()
      .then(() =>
        this.runner.run({
          ...options,
          taskId: task.id,
          abortController: task.abortController,
        }),
      )
      .then(
        (result) => {
          this.finish(task, result);
          this.drainQueue();
          resolve(result);
        },
        (error) => {
          if (task.status !== "timed_out") {
            task.status = "failed";
            task.endedAt = new Date().toISOString();
            task.error = error instanceof Error ? error.message : String(error);
          }
          this.drainQueue();
          reject(error);
        },
      );
  }

  private drainQueue(): void {
    while (this.runningCount() < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift();
      if (next) this.launch(next);
    }
  }

  list(): readonly StructuredSubagentTask[] {
    return [...this.tasks.values()];
  }

  async waitForChildren(timeoutMs = this.forkWaitTimeoutMs): Promise<readonly StructuredSubagentTask[]> {
    assertTimeout(timeoutMs);
    const running = this.list().filter((task) => task.status === "running" || task.status === "queued");
    if (!running.length) return this.list();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const settled = Promise.all(running.map((task) => task.promise)).then(() => "settled" as const);
    const outcome = await Promise.race([settled, expired]);
    if (timeout) clearTimeout(timeout);
    if (outcome === "timeout") {
      const timedOutAt = new Date().toISOString();
      const pending = running.filter((task) => task.status === "running");
      for (const task of pending) {
        task.status = "timed_out";
        task.endedAt = timedOutAt;
        task.error = `timed out after ${timeoutMs}ms and was cancelled`;
        task.abortController.abort();
      }
      await Promise.allSettled(pending.map((task) => task.promise));
    }
    return this.list();
  }

  summary(): string {
    if (!this.tasks.size) return "";
    const lines = ["Subagent execution summary:"];
    for (const task of this.tasks.values()) {
      if (task.status === "timed_out") {
        lines.push(`- ${task.name}: ${task.error ?? "timed out and was cancelled"}`);
      } else if (task.status === "failed") {
        lines.push(`- ${task.name}: failed${task.error ? ` — ${singleLine(task.error)}` : ""}`);
      } else if (task.status === "cancelled") {
        lines.push(`- ${task.name}: cancelled`);
      } else {
        lines.push(`- ${task.name}: ${task.status}`);
      }
    }
    return lines.join("\n");
  }

  cancelAll(): void {
    // 排队中的 fork 还没有真实 promise,必须在这里落定,否则等待方会永久挂起。
    for (const entry of [...this.queue]) {
      entry.task.status = "cancelled";
      entry.task.endedAt = new Date().toISOString();
      entry.reject(new Error("fork cancelled while queued"));
    }
    this.queue.length = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") task.abortController.abort();
    }
  }

  private finish(task: StructuredSubagentTask, result: SubagentRunResult): void {
    if (task.status === "timed_out") return;
    task.status = result.status;
    task.endedAt = result.endedAt;
    task.output = result.output;
    task.usage = result.usage;
    if (result.error) task.error = result.error;
  }
}

export function unsupportedContinueAfterParentExit(): UnsupportedSubagentOperation {
  return {
    code: "unsupported_operation",
    operation: "continue_after_parent_exit",
    message: "Continuing a subagent after the parent process exits requires a persistent Task Host.",
  };
}

function assertTimeout(value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("subagent fork wait timeout must be a finite non-negative number");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
