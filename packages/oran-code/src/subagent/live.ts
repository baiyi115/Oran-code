import { describeToolActivity } from "../tool-names.js";
import { normalizeTokenUsage } from "../token-usage.js";
import type { SubagentEvent, SubagentOrigin, StructuredSubagentStatus } from "./types.js";

/** One delegated task as the TUI's task panel sees it while it runs. */
export interface LiveSubagentTask {
  readonly id: string;
  readonly name: string;
  readonly origin: SubagentOrigin;
  status: StructuredSubagentStatus;
  readonly startedAt: string;
  endedAt?: string;
  /** What the task is doing right now; absent before its first tool call. */
  activity?: string;
  /** Output tokens the task has spent so far. */
  tokens: number;
  error?: string;
  /** Session that owns the run, so a session switch does not resurrect the previous one's rows. */
  readonly sessionId?: string;
}

/** A finished task stays listable for a while after it ends; the panel's own linger is shorter. */
const FINISHED_RETENTION_MS = 10 * 60_000;

/**
 * Live view of every delegated task the session has seen, foreground and background alike.
 *
 * Background tasks already have an owner (`BackgroundAgentTaskManager`); this store exists for the
 * ones that do not: a synchronous `agent` call is just an `await` in the parent's tool loop, and
 * nothing the TUI can look up used to name it or say what it was doing. The event stream is the
 * only signal, so this keeps the last activity and token count per task.
 */
export class LiveSubagentTasks {
  private readonly tasks = new Map<string, LiveSubagentTask>();

  /** Records one event; true when what the panel shows for this task changed. */
  observe(event: SubagentEvent, sessionId: string | undefined): boolean {
    const terminal = event.status !== "queued" && event.status !== "running";
    const previous = this.tasks.get(event.taskId);
    // Snapshot before mutating: an existing entry is updated in place, so comparing against it
    // afterwards would always say "unchanged".
    const before = previous
      ? { activity: previous.activity, status: previous.status, tokens: previous.tokens, endedAt: previous.endedAt }
      : undefined;
    const task: LiveSubagentTask =
      previous ??
      ({
        id: event.taskId,
        name: event.name,
        origin: event.origin,
        status: event.status,
        startedAt: event.startedAt ?? event.timestamp,
        tokens: 0,
        ...(sessionId ? { sessionId } : {}),
      } satisfies LiveSubagentTask);

    task.status = event.status;
    const activity = activityFromEvent(event);
    if (activity !== undefined) task.activity = activity;
    if (event.usage) {
      task.tokens = Math.max(task.tokens, normalizeTokenUsage({ ...event.usage }).outputTokens);
    }
    if (terminal) {
      task.endedAt = event.endedAt ?? event.timestamp;
      if (event.error) task.error = event.error;
      else delete task.error;
      this.prune();
    } else {
      delete task.endedAt;
      delete task.error;
    }
    this.tasks.set(task.id, task);

    return (
      task.activity !== before?.activity ||
      task.status !== before?.status ||
      task.tokens !== before?.tokens ||
      task.endedAt !== before?.endedAt
    );
  }

  /** Tasks for one session (all sessions when none is named), oldest first. */
  list(sessionId?: string): readonly LiveSubagentTask[] {
    return [...this.tasks.values()]
      .filter((task) => sessionId === undefined || task.sessionId === sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  private prune(now = Date.now()): void {
    for (const [id, task] of this.tasks) {
      const endedAt = task.endedAt ? Date.parse(task.endedAt) : Number.NaN;
      if (Number.isFinite(endedAt) && now - endedAt > FINISHED_RETENTION_MS) this.tasks.delete(id);
    }
  }
}

/**
 * The one line a row can show: the tool the task is running now. A `tool_progress` note names the
 * same call more precisely, so it wins while it lasts; a thinking turn falls back to "Thinking" so
 * the row never sits on a stale tool name for the whole model call.
 */
function activityFromEvent(event: SubagentEvent): string | undefined {
  const runtime = event.runtimeEvent;
  if (!runtime) return undefined;
  switch (runtime.type) {
    case "tool_start":
      return describeToolActivity(runtime.call);
    case "tool_progress": {
      const note = runtime.note.replace(/\s+/g, " ").trim();
      return note || undefined;
    }
    case "thought_start":
      return "Thinking";
    default:
      return undefined;
  }
}
