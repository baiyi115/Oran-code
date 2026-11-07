import { randomUUID } from "node:crypto";
import type { SubagentRunner } from "./runner.js";
import type { AgentMessageBus } from "./messages.js";
import type {
  StructuredSubagentTask,
  SubagentRunOptions,
  SubagentRunResult,
  UnsupportedSubagentOperation,
} from "./types.js";

export const DEFAULT_FORK_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_FORK_CONCURRENCY = 4;
const MAX_FORK_RESULT_CHARS = 16_000;

export class StructuredSubagentScope {
  private readonly tasks = new Map<string, StructuredSubagentTask>();
  private readonly notified = new Set<string>();
  private readonly queue: Array<{
    options: SubagentRunOptions;
    task: StructuredSubagentTask;
    resolve: (result: SubagentRunResult) => void;
  }> = [];
  private readonly maxConcurrent: number;

  constructor(
    private readonly runner: SubagentRunner,
    readonly forkWaitTimeoutMs = DEFAULT_FORK_WAIT_TIMEOUT_MS,
    maxConcurrent = DEFAULT_FORK_CONCURRENCY,
    private readonly messages?: AgentMessageBus,
  ) {
    assertTimeout(forkWaitTimeoutMs);
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  start(options: SubagentRunOptions): StructuredSubagentTask | UnsupportedSubagentOperation {
    if (options.continueAfterParentExit) return unsupportedContinueAfterParentExit();
    const id = options.taskId ?? `fork-${randomUUID()}`;
    if (options.background) this.messages?.registerTask(id, options.parentSessionId);
    const abortController = options.abortController ?? new AbortController();
    // Forks are constrained by the same concurrency cap as background tasks: a batch of N agent
    // calls must not fire N model requests at once; the excess waits in the queue.
    let resolve!: (result: SubagentRunResult) => void;
    const promise = new Promise<SubagentRunResult>((res) => {
      resolve = res;
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
    const entry = { options, task, resolve };
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
  }): void {
    const { options, task, resolve } = entry;
    task.status = "running";
    Promise.resolve()
      .then(() =>
        this.runner.run({
          ...options,
          taskId: task.id,
          abortController: task.abortController,
        }),
      )
      .catch((error: unknown): SubagentRunResult => ({
        ...this.terminalResult(task, "failed", ""),
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        const forcedStatus = task.status === "timed_out" || task.status === "cancelled" ? task.status : undefined;
        this.finish(task, result);
        this.drainQueue();
        resolve(forcedStatus ? this.terminalResult(task, forcedStatus, task.output ?? "") : result);
      });
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

  /** Return each finished result once for the parent's next model request. */
  drainNotifications(): readonly StructuredSubagentTask[] {
    const finished = this.list().filter(
      (task) => task.status !== "running" && task.status !== "queued" && !this.notified.has(task.id),
    );
    for (const task of finished) this.notified.add(task.id);
    return finished;
  }

  async waitForChildren(timeoutMs = this.forkWaitTimeoutMs): Promise<readonly StructuredSubagentTask[]> {
    assertTimeout(timeoutMs);
    const running = this.list().filter((task) => task.status === "running" || task.status === "queued");
    if (!running.length) return this.list();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const settled = Promise.allSettled(running.map((task) => task.promise)).then(() => "settled" as const);
    const outcome = await Promise.race([settled, expired]);
    if (timeout) clearTimeout(timeout);
    if (outcome === "timeout") {
      const message = `timed out after ${timeoutMs}ms and was cancelled`;
      for (const entry of [...this.queue]) this.cancelQueued(entry, "timed_out", message);
      for (const task of running) {
        if (task.status !== "running") continue;
        task.status = "timed_out";
        task.endedAt = new Date().toISOString();
        task.error = message;
        task.abortController.abort();
      }
      await this.waitForSettlement();
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
      if (task.output?.trim()) {
        const output = task.output.trim();
        lines.push(
          output.length > MAX_FORK_RESULT_CHARS
            ? `${output.slice(0, MAX_FORK_RESULT_CHARS)}\n...[truncated ${output.length - MAX_FORK_RESULT_CHARS} chars]`
            : output,
        );
      }
    }
    return lines.join("\n");
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || (task.status !== "running" && task.status !== "queued")) return false;
    if (task.status === "queued") {
      const entry = this.queue.find((item) => item.task.id === id);
      if (entry) this.cancelQueued(entry, "cancelled", "Task cancelled while queued.");
    } else {
      task.abortController.abort();
    }
    return true;
  }

  cancelAll(): void {
    for (const entry of [...this.queue]) this.cancelQueued(entry, "cancelled", "Task cancelled while queued.");
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "cancelled";
      task.endedAt = new Date().toISOString();
      task.error = "Task cancelled with parent.";
      task.abortController.abort();
    }
  }

  /** Never let an unresponsive child keep the parent process waiting forever after cancellation. */
  async waitForSettlement(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(this.list().map((task) => task.promise)),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private cancelQueued(entry: (typeof this.queue)[number], status: "cancelled" | "timed_out", message: string): void {
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    entry.task.status = status;
    void this.messages?.finishTask(entry.task.id).catch(() => undefined);
    entry.task.endedAt = new Date().toISOString();
    entry.task.abortController.abort();
    if (status === "timed_out") entry.task.error = message;
    else entry.task.output = message;
    entry.resolve(this.terminalResult(entry.task, status, entry.task.output ?? ""));
  }

  private terminalResult(
    task: StructuredSubagentTask,
    status: SubagentRunResult["status"],
    output: string,
  ): SubagentRunResult {
    return {
      taskId: task.id,
      name: task.name,
      origin: task.origin,
      status,
      output,
      usage: task.usage,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? new Date().toISOString(),
      conversation: [],
      workspace: "",
      ...(task.error ? { error: task.error } : {}),
    };
  }

  private finish(task: StructuredSubagentTask, result: SubagentRunResult): void {
    if (task.status === "timed_out" || task.status === "cancelled") return;
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
