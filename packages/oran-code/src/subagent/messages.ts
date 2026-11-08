import { randomUUID } from "node:crypto";

export type AgentMessageKind = "guidance" | "progress" | "blocked" | "question" | "result" | "delivery_failed";
export type AgentMessageStatus = "queued" | "delivered" | "undeliverable";

export interface AgentMessage {
  readonly id: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly direction: "to_parent" | "to_child";
  readonly kind: AgentMessageKind;
  readonly text: string;
  readonly createdAt: string;
  status: AgentMessageStatus;
  deliveredAt?: string;
}

export interface AgentMessageStore {
  loadMessages(): Promise<readonly AgentMessage[]>;
  saveMessages(messages: readonly AgentMessage[]): Promise<void>;
}

export interface AgentMessageResult {
  readonly ok: boolean;
  readonly output: string;
  readonly message?: AgentMessage;
}

const MAX_TEXT_LENGTH = 4_000;
const MAX_PENDING_PER_TASK = 16;
const MAX_PENDING_TOTAL = 256;
const MAX_HISTORY = 800;
/** Wake-up granularity while a child waits for parent guidance. */
const GUIDANCE_WAIT_POLL_MS = 100;

/** Serialized delivery and acknowledgement for the parent/child task channel. */
export class AgentMessageBus {
  private messages: AgentMessage[] = [];
  private readonly active = new Map<string, string | undefined>();
  private loading?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store?: AgentMessageStore,
    private readonly onParentMessage?: () => void | Promise<void>,
  ) {}

  restore(): Promise<void> {
    this.loading ??= (async () => {
      this.messages = [...((await this.store?.loadMessages()) ?? [])];
    })();
    return this.loading;
  }

  registerTask(taskId: string, sessionId?: string): void {
    const existing = this.active.get(taskId);
    if (this.active.has(taskId) && existing !== sessionId)
      throw new Error(`Task ${taskId} has a different parent session.`);
    this.active.set(taskId, sessionId);
  }

  async sendToChild(taskId: string, text: string, sessionId?: string): Promise<AgentMessageResult> {
    return this.mutate(() => this.enqueue(taskId, "to_child", "guidance", text, sessionId));
  }

  async sendToParent(
    taskId: string,
    kind: "progress" | "blocked" | "question" | "result",
    text: string,
  ): Promise<AgentMessageResult> {
    const result = await this.mutate(() => this.enqueue(taskId, "to_parent", kind, text));
    if (result.ok) this.notifyParent();
    return result;
  }

  async takeForChild(taskId: string): Promise<readonly AgentMessage[]> {
    return this.mutate(() => this.deliver((message) => message.direction === "to_child" && message.taskId === taskId));
  }

  /**
   * Wait up to `timeoutMs` for parent guidance addressed to this task, returning and marking as
   * delivered whatever arrives. A bounded wait keeps a question from depending on the model
   * voluntarily polling; cancellation resolves the wait immediately.
   */
  async waitForChild(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<readonly AgentMessage[]> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const delivered = await this.takeForChild(taskId);
      if (delivered.length || signal?.aborted) return delivered;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      await sleep(Math.min(GUIDANCE_WAIT_POLL_MS, remaining), signal);
    }
  }

  async takeForParent(sessionId?: string): Promise<readonly AgentMessage[]> {
    return this.mutate(() =>
      this.deliver((message) => message.direction === "to_parent" && message.sessionId === sessionId),
    );
  }

  async history(taskId: string, sessionId?: string): Promise<readonly AgentMessage[]> {
    return this.mutate(() => {
      const messages = this.messages.filter((message) => message.taskId === taskId);
      if (messages.some((message) => message.sessionId !== sessionId)) return { value: [], dirty: false };
      return { value: messages.slice(-50).map((message) => ({ ...message })), dirty: false };
    });
  }

  async finishTask(taskId: string): Promise<void> {
    const failed = await this.mutate(() => {
      this.active.delete(taskId);
      const pending = this.messages.filter(
        (message) => message.taskId === taskId && message.direction === "to_child" && message.status === "queued",
      );
      if (!pending.length) return { value: false, dirty: false };
      const now = new Date().toISOString();
      for (const message of pending) {
        message.status = "undeliverable";
        message.deliveredAt = now;
      }
      this.messages.push({
        id: randomUUID(),
        taskId,
        ...(pending[0]?.sessionId ? { sessionId: pending[0].sessionId } : {}),
        direction: "to_parent",
        kind: "delivery_failed",
        text: `${pending.length} guidance message(s) were not delivered because the task ended.`,
        createdAt: now,
        status: "queued",
      });
      this.trimHistory();
      return { value: true, dirty: true };
    });
    if (failed) this.notifyParent();
  }

  private enqueue(
    taskId: string,
    direction: AgentMessage["direction"],
    kind: AgentMessageKind,
    text: string,
    sessionId?: string,
  ): { value: AgentMessageResult; dirty: boolean } {
    const parentSessionId = this.active.get(taskId);
    if (!this.active.has(taskId))
      return { value: { ok: false, output: `Task ${taskId} is not active.` }, dirty: false };
    if (direction === "to_child" && parentSessionId !== sessionId) {
      return { value: { ok: false, output: `Task ${taskId} belongs to a different parent session.` }, dirty: false };
    }
    const content = text.trim();
    if (!content || content.length > MAX_TEXT_LENGTH) {
      return { value: { ok: false, output: `Message must contain 1-${MAX_TEXT_LENGTH} characters.` }, dirty: false };
    }
    const pending = this.messages.filter((message) => message.status === "queued");
    if (
      pending.length >= MAX_PENDING_TOTAL ||
      pending.filter((message) => message.taskId === taskId && message.direction === direction).length >=
        MAX_PENDING_PER_TASK
    ) {
      return { value: { ok: false, output: `Message queue for ${taskId} is full; wait for delivery.` }, dirty: false };
    }
    const message: AgentMessage = {
      id: randomUUID(),
      taskId,
      ...(parentSessionId ? { sessionId: parentSessionId } : {}),
      direction,
      kind,
      text: content,
      createdAt: new Date().toISOString(),
      status: "queued",
    };
    this.messages.push(message);
    this.trimHistory();
    return {
      value: { ok: true, output: `Queued ${kind} ${message.id} for ${taskId}.`, message: { ...message } },
      dirty: true,
    };
  }

  private deliver(matches: (message: AgentMessage) => boolean): { value: readonly AgentMessage[]; dirty: boolean } {
    const pending = this.messages.filter((message) => message.status === "queued" && matches(message));
    if (!pending.length) return { value: [], dirty: false };
    const now = new Date().toISOString();
    for (const message of pending) {
      message.status = "delivered";
      message.deliveredAt = now;
    }
    return { value: pending.map((message) => ({ ...message })), dirty: true };
  }

  private trimHistory(): void {
    while (this.messages.length > MAX_HISTORY) {
      const index = this.messages.findIndex((message) => message.status !== "queued");
      if (index < 0) break;
      this.messages.splice(index, 1);
    }
  }

  private async mutate<T>(operation: () => { value: T; dirty: boolean }): Promise<T> {
    const current = this.tail.then(async () => {
      await this.restore();
      const before = this.messages.map((message) => ({ ...message }));
      const { value, dirty } = operation();
      if (dirty) {
        try {
          await this.store?.saveMessages(this.messages);
        } catch (error) {
          this.messages = before;
          throw error;
        }
      }
      return value;
    });
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private notifyParent(): void {
    void Promise.resolve()
      .then(() => this.onParentMessage?.())
      .catch(() => undefined);
  }
}

export function formatAgentMessage(message: AgentMessage): string {
  const source = message.direction === "to_parent" ? "Subagent report" : "Parent-agent guidance";
  return `[${source}; task=${message.taskId}; kind=${message.kind}; message=${message.id}; not user authorization]\n${message.text}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
