import { randomUUID } from "node:crypto";
import type { ModelConfig } from "../types.js";
import type { SubagentRunner } from "./runner.js";
import type { AgentStateStore, PersistedBackgroundTask } from "./state-store.js";
import type { AgentDefinition, BackgroundAgentTask, SubagentRunOptions, SubagentRunResult } from "./types.js";

export class BackgroundAgentTaskManager {
  private readonly tasks = new Map<string, BackgroundAgentTask>();
  private nextId = 1;

  constructor(
    private readonly stateStore?: AgentStateStore,
    private readonly onTerminal?: () => void | Promise<void>,
  ) {}

  async restore(): Promise<void> {
    if (!this.stateStore) return;
    const state = await this.stateStore.load();
    for (const item of state.background) {
      const status = item.status === "running" ? "interrupted" : item.status;
      this.tasks.set(item.id, { ...structuredClone(item), status });
    }
    await this.persist();
  }

  start(runner: SubagentRunner, options: SubagentRunOptions & { readonly retryOf?: string }): BackgroundAgentTask {
    const id = options.taskId ?? `agent-${this.nextId++}-${randomUUID().slice(0, 8)}`;
    const abortController = options.abortController ?? new AbortController();
    const promise = Promise.resolve().then(() => runner.run({
      ...options,
      taskId: id,
      abortController,
      background: true,
      worktreeLeaseCallback: async (lease) => {
        const current = this.tasks.get(id);
        if (!current) return;
        if (lease) current.worktreeLease = lease;
        else delete current.worktreeLease;
        await this.persist();
      },
    }));
    const task: BackgroundAgentTask = {
      id,
      name: options.description,
      origin: options.origin,
      prompt: options.prompt,
      startedAt: new Date().toISOString(),
      status: "running",
      usage: {},
      notified: false,
      ...(options.definition ? { definitionName: options.definition.name } : {}),
      ...(options.model ? { modelReference: modelReference(options.model) } : {}),
      ...(options.worktreeLease ? { worktreeLease: options.worktreeLease } : {}),
      ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      abortController,
      promise,
    };
    this.tasks.set(id, task);
    this.schedulePersist();
    void promise.then(async (result) => {
      this.finish(task, result);
      await this.persist();
      await this.onTerminal?.();
    }).catch(() => undefined);
    return task;
  }

  retry(
    id: string,
    runner: SubagentRunner,
    options: { readonly definition?: AgentDefinition; readonly model?: ModelConfig } = {},
  ): BackgroundAgentTask | undefined {
    const previous = this.tasks.get(id);
    if (!previous || previous.status === "running") return undefined;
    return this.start(runner, {
      description: previous.name,
      prompt: previous.prompt,
      origin: previous.origin,
      ...(options.definition ? { definition: options.definition } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(previous.worktreeLease ? { worktreeLease: previous.worktreeLease } : {}),
      retryOf: previous.id,
    });
  }

  get(id: string): BackgroundAgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): readonly BackgroundAgentTask[] {
    return [...this.tasks.values()];
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running" || !task.abortController) return false;
    task.abortController.abort();
    return true;
  }

  cancelAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") task.abortController?.abort();
    }
  }

  interruptAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "interrupted";
      task.endedAt = new Date().toISOString();
      task.abortController?.abort();
    }
    this.schedulePersist();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.list().flatMap((task) => task.promise ? [task.promise] : []));
  }

  drainNotifications(): readonly BackgroundAgentTask[] {
    const notifications: BackgroundAgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.notified) continue;
      task.notified = true;
      notifications.push(task);
    }
    if (notifications.length) this.schedulePersist();
    return notifications;
  }

  async flush(): Promise<void> {
    await this.persist();
  }

  private finish(task: BackgroundAgentTask, result: SubagentRunResult): void {
    const interrupted = task.status === "interrupted";
    if (task.status !== "running" && !interrupted) return;
    if (!interrupted) task.status = result.status;
    task.endedAt = result.endedAt;
    task.output = result.output;
    task.usage = result.usage;
    if (result.worktreeLease) task.worktreeLease = result.worktreeLease;
    else delete task.worktreeLease;
    if (result.error) task.error = result.error;
    else delete task.error;
  }

  private async persist(): Promise<void> {
    await this.stateStore?.saveBackground(this.list().map(serializeTask));
  }

  /** 中间态(登记任务、消费通知)落盘走防抖,终态仍立即持久化。 */
  private schedulePersist(): void {
    this.stateStore?.scheduleSaveBackground(this.list().map(serializeTask));
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

function serializeTask(task: BackgroundAgentTask): PersistedBackgroundTask {
  const { promise: _promise, abortController: _abortController, ...persisted } = task;
  return persisted;
}

function modelReference(model: ModelConfig): string {
  return `${model.provider}/${model.model}`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
