import { randomUUID } from "node:crypto";
import type { ModelConfig } from "../types.js";
import type { SubagentRunner } from "./runner.js";
import type { AgentStateStore, PersistedBackgroundTask } from "./state-store.js";
import type { AgentDefinition, BackgroundAgentTask, SubagentRunOptions, SubagentRunResult } from "./types.js";

interface QueuedTask {
  readonly task: BackgroundAgentTask;
  readonly runner: SubagentRunner;
  readonly options: SubagentRunOptions & { readonly retryOf?: string };
  readonly resolve: (result: SubagentRunResult) => void;
  readonly reject: (error: unknown) => void;
}

export class BackgroundAgentTaskManager {
  private readonly tasks = new Map<string, BackgroundAgentTask>();
  private readonly queue: QueuedTask[] = [];
  private readonly maxConcurrent: number;
  private nextId = 1;

  constructor(
    private readonly stateStore?: AgentStateStore,
    private readonly onTerminal?: () => void | Promise<void>,
    private readonly onChange?: () => void,
    options?: { readonly maxConcurrent?: number },
  ) {
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? 4);
  }

  private notifyChange(): void {
    try {
      this.onChange?.();
    } catch {
      // ignore
    }
  }

  private runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") count += 1;
    }
    return count;
  }

  async restore(): Promise<void> {
    if (!this.stateStore) return;
    const state = await this.stateStore.load();
    for (const item of state.background) {
      const status = item.status === "running" || item.status === "queued" ? "interrupted" : item.status;
      this.tasks.set(item.id, { ...structuredClone(item), status });
    }
    await this.persist();
    this.notifyChange();
  }

  start(runner: SubagentRunner, options: SubagentRunOptions & { readonly retryOf?: string }): BackgroundAgentTask {
    const id = options.taskId ?? `agent-${this.nextId++}-${randomUUID().slice(0, 8)}`;
    const abortController = options.abortController ?? new AbortController();

    let resolvePromise!: (result: SubagentRunResult) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<SubagentRunResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const isRunning = this.runningCount() < this.maxConcurrent;
    const task: BackgroundAgentTask = {
      id,
      name: options.description,
      origin: options.origin,
      prompt: options.prompt,
      startedAt: new Date().toISOString(),
      status: isRunning ? "running" : "queued",
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

    if (isRunning) {
      this.dispatch(task, runner, options, resolvePromise, rejectPromise);
    } else {
      this.queue.push({ task, runner, options, resolve: resolvePromise, reject: rejectPromise });
    }

    this.schedulePersist();
    this.notifyChange();
    return task;
  }

  private dispatch(
    task: BackgroundAgentTask,
    runner: SubagentRunner,
    options: SubagentRunOptions & { readonly retryOf?: string },
    resolvePromise: (result: SubagentRunResult) => void,
    _rejectPromise: (error: unknown) => void,
  ): void {
    const runPromise = runner.run({
      ...options,
      taskId: task.id,
      ...(task.abortController ? { abortController: task.abortController } : {}),
      background: true,
      worktreeLeaseCallback: async (lease) => {
        const current = this.tasks.get(task.id);
        if (!current) return;
        if (lease) current.worktreeLease = lease;
        else delete current.worktreeLease;
        await this.persist();
      },
    });

    void runPromise
      .then(async (result) => {
        this.finish(task, result);
        await this.persist();
        this.notifyChange();
        this.drainQueue();
        await this.onTerminal?.();
        resolvePromise(result);
      })
      .catch((error) => {
        const errorResult: SubagentRunResult = {
          taskId: task.id,
          name: task.name,
          origin: task.origin,
          status: "failed",
          output: "",
          error: error instanceof Error ? error.message : String(error),
          usage: {},
          startedAt: task.startedAt,
          endedAt: new Date().toISOString(),
          conversation: [],
          workspace: "",
        };
        this.finish(task, errorResult);
        void this.persist();
        this.notifyChange();
        this.drainQueue();
        resolvePromise(errorResult);
      });
  }

  private drainQueue(): void {
    while (this.runningCount() < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      if (next.task.status !== "queued") continue;
      next.task.status = "running";
      next.task.startedAt = new Date().toISOString();
      this.schedulePersist();
      this.notifyChange();
      this.dispatch(next.task, next.runner, next.options, next.resolve, next.reject);
    }
  }

  retry(
    id: string,
    runner: SubagentRunner,
    options: { readonly definition?: AgentDefinition; readonly model?: ModelConfig } = {},
  ): BackgroundAgentTask | undefined {
    const previous = this.tasks.get(id);
    if (!previous || previous.status === "running" || previous.status === "queued") return undefined;
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
    if (!task || (task.status !== "running" && task.status !== "queued") || !task.abortController) return false;
    if (task.status === "queued") {
      const index = this.queue.findIndex((item) => item.task.id === id);
      if (index >= 0) {
        const [removed] = this.queue.splice(index, 1);
        removed?.resolve({
          taskId: task.id,
          name: task.name,
          origin: task.origin,
          status: "cancelled",
          output: "Task cancelled while queued.",
          usage: {},
          startedAt: task.startedAt,
          endedAt: new Date().toISOString(),
          conversation: [],
          workspace: "",
        });
      }
      task.status = "cancelled";
      task.endedAt = new Date().toISOString();
      task.output = "Task cancelled while queued.";
      task.abortController.abort();
      this.schedulePersist();
      this.notifyChange();
      return true;
    }
    task.abortController.abort();
    this.notifyChange();
    return true;
  }

  cancelAll(): void {
    for (const item of [...this.queue]) {
      item.task.status = "cancelled";
      item.task.endedAt = new Date().toISOString();
      item.task.output = "Task cancelled while queued.";
      item.task.abortController?.abort();
      item.resolve({
        taskId: item.task.id,
        name: item.task.name,
        origin: item.task.origin,
        status: "cancelled",
        output: "Task cancelled while queued.",
        usage: {},
        startedAt: item.task.startedAt,
        endedAt: item.task.endedAt,
        conversation: [],
        workspace: "",
      });
    }
    this.queue.length = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") task.abortController?.abort();
    }
    this.schedulePersist();
    this.notifyChange();
  }

  interruptAll(): void {
    for (const item of [...this.queue]) {
      item.task.status = "interrupted";
      item.task.endedAt = new Date().toISOString();
      item.task.abortController?.abort();
      item.resolve({
        taskId: item.task.id,
        name: item.task.name,
        origin: item.task.origin,
        status: "cancelled",
        output: "Task interrupted.",
        usage: {},
        startedAt: item.task.startedAt,
        endedAt: item.task.endedAt,
        conversation: [],
        workspace: "",
      });
    }
    this.queue.length = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== "running" && task.status !== "queued") continue;
      task.status = "interrupted";
      task.endedAt = new Date().toISOString();
      task.abortController?.abort();
    }
    this.schedulePersist();
    this.notifyChange();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.list().flatMap((task) => task.promise ? [task.promise] : []));
  }

  drainNotifications(): readonly BackgroundAgentTask[] {
    const notifications: BackgroundAgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "queued" || task.notified) continue;
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
