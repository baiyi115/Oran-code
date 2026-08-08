import { randomUUID } from "node:crypto";
import type { SubagentRunner } from "./runner.js";
import type { BackgroundAgentTask, SubagentRunOptions, SubagentRunResult } from "./types.js";

export class BackgroundAgentTaskManager {
  private readonly tasks = new Map<string, BackgroundAgentTask>();
  private nextId = 1;

  constructor(private readonly onTerminal?: () => void | Promise<void>) {}

  start(runner: SubagentRunner, options: SubagentRunOptions): BackgroundAgentTask {
    const id = options.taskId ?? `agent-${this.nextId++}-${randomUUID().slice(0, 8)}`;
    const abortController = options.abortController ?? new AbortController();
    const promise = Promise.resolve().then(() => runner.run({
      ...options,
      taskId: id,
      abortController,
      background: true,
    }));
    const task: BackgroundAgentTask = {
      id,
      name: options.description,
      origin: options.origin,
      startedAt: new Date().toISOString(),
      status: "running",
      usage: {},
      notified: false,
      abortController,
      promise,
    };
    this.tasks.set(id, task);
    void promise.then(async (result) => {
      this.finish(task, result);
      await this.onTerminal?.();
    }).catch(() => undefined);
    return task;
  }

  get(id: string): BackgroundAgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): readonly BackgroundAgentTask[] {
    return [...this.tasks.values()];
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return false;
    task.abortController.abort();
    return true;
  }

  cancelAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") task.abortController.abort();
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.list().map((task) => task.promise));
  }

  drainNotifications(): readonly BackgroundAgentTask[] {
    const notifications: BackgroundAgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.notified) continue;
      task.notified = true;
      notifications.push(task);
    }
    return notifications;
  }

  private finish(task: BackgroundAgentTask, result: SubagentRunResult): void {
    if (task.status !== "running") return;
    task.status = result.status;
    task.endedAt = result.endedAt;
    task.output = result.output;
    task.usage = result.usage;
    if (result.error) task.error = result.error;
  }
}

export function backgroundTaskNotification(task: BackgroundAgentTask): string {
  const output = task.output ?? task.error ?? "No result was produced.";
  return [
    "<task-notification>",
    `Task ${task.id} (name="${escapeAttribute(task.name)}"): ${task.status}`,
    `Result: ${output}`,
    "</task-notification>",
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
