import { randomUUID } from "node:crypto";
import type { SubagentRunner } from "./runner.js";
import type {
  StructuredSubagentTask,
  SubagentRunOptions,
  SubagentRunResult,
  UnsupportedSubagentOperation,
} from "./types.js";

export const DEFAULT_FORK_WAIT_TIMEOUT_MS = 600_000;

export class StructuredSubagentScope {
  private readonly tasks = new Map<string, StructuredSubagentTask>();

  constructor(
    private readonly runner: SubagentRunner,
    readonly forkWaitTimeoutMs = DEFAULT_FORK_WAIT_TIMEOUT_MS,
  ) {
    assertTimeout(forkWaitTimeoutMs);
  }

  start(options: SubagentRunOptions): StructuredSubagentTask | UnsupportedSubagentOperation {
    if (options.continueAfterParentExit) return unsupportedContinueAfterParentExit();
    const id = options.taskId ?? `fork-${randomUUID()}`;
    const abortController = options.abortController ?? new AbortController();
    const promise = Promise.resolve().then(() =>
      this.runner.run({
        ...options,
        taskId: id,
        abortController,
      }),
    );
    const task: StructuredSubagentTask = {
      id,
      name: options.description,
      origin: options.origin,
      startedAt: new Date().toISOString(),
      status: "running",
      usage: {},
      abortController,
      promise,
    };
    this.tasks.set(id, task);
    void promise.then((result) => this.finish(task, result));
    return task;
  }

  list(): readonly StructuredSubagentTask[] {
    return [...this.tasks.values()];
  }

  async waitForChildren(timeoutMs = this.forkWaitTimeoutMs): Promise<readonly StructuredSubagentTask[]> {
    assertTimeout(timeoutMs);
    const running = this.list().filter((task) => task.status === "running");
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
