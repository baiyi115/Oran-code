import { PERMISSION_MODE_LABELS } from "../types.js";
import type { TranscriptMessage, TuiState } from "./types.js";
import { abbreviatePath, truncateVisible, visibleWidth } from "./text-width.js";
import { hasActiveBackgroundTasks, isSessionBusy } from "./status-indicator.js";
import { formatDuration, formatRate } from "../formatting.js";

/**
 * Footer layout (bottom chrome): the mode line, then the workspace path with
 * the current state beside it — token usage, queued follow-ups, permission mode,
 * context usage, running subagents and shell jobs, and any user-facing status.
 * When that detail no longer fits next to the path it moves to its own line.
 */
export function footerLines(state: TuiState, width: number): string[] {
  const available = Math.max(1, Math.floor(width));
  const mode = permissionChip(state);
  const primary = [
    available >= 70 ? `${mode} (shift+tab)` : mode,
    state.session.reasoningEffort,
    state.session.modelLabel || "(not selected)",
  ]
    .filter(Boolean)
    .join(" · ");

  const workspace = state.session.workspace || ".";
  const usage = usageLabel(state);
  const queue = state.session.followUpCount > 0 ? `follow-ups: ${state.session.followUpCount}` : undefined;
  // No subagent or job badges here: the task panel below the composer already lists every
  // subagent, and the working line above it already names running shell jobs. Repeating the
  // counts in the footer only made the detail line longer.
  const status = explicitStatus(state);

  // Status first: the detail line is truncated from the right, and an error or hint is the part
  // that must never be cut away. Usage is bracketed so the two levels read as two levels.
  const detail = [status, usage, subagentUsageChip(state), queue, contextChip(state), detailsHint(state)]
    .filter(Boolean)
    .join(" · ");
  const lines = [truncateVisible(primary, available)];
  if (!detail) return [...lines, abbreviatePath(workspace, available)];

  const separator = "  ·  ";
  const detailWidth = visibleWidth(detail);
  const workspaceWidth = Math.max(12, available - detailWidth - visibleWidth(separator));
  if (workspaceWidth + detailWidth + visibleWidth(separator) <= available) {
    lines.push(`${abbreviatePath(workspace, workspaceWidth)}${separator}${detail}`);
  } else {
    lines.push(abbreviatePath(workspace, available));
    lines.push(truncateVisible(detail, available));
  }
  return lines;
}

/** Outcome tone of a finished turn, so the summary row can stop painting a failure green. */
export type WorkSummaryTone = "done" | "failed" | "cancelled";

export interface WorkSummary {
  text: string;
  tone: WorkSummaryTone;
}

/** Compact completed-turn summary shown above the composer. */
export function workSummaryLine(state: TuiState): WorkSummary | undefined {
  if (isSessionBusy(state) || hasActiveBackgroundTasks(state)) return undefined;
  const elapsed = state.session.elapsedMs;
  if (elapsed === undefined || elapsed < 0) return undefined;
  const tone: WorkSummaryTone =
    state.session.taskState === "failed"
      ? "failed"
      : state.session.taskState === "cancelled" || state.session.taskState === "paused"
        ? "cancelled"
        : "done";
  const label =
    state.session.taskState === "failed"
      ? "× Failed"
      : state.session.taskState === "cancelled"
        ? "■ Cancelled"
        : state.session.taskState === "paused"
          ? "■ Paused"
          : "✓ Done";
  const details = [label, formatDuration(elapsed)];
  const toolCount = currentTaskMessages(state).filter((message) => message.kind === "tool").length;
  if (toolCount > 0) details.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  const usage = state.activeTaskUsage;
  if (usage.totalTokens > 0) {
    const tokenParts = [`in ${compactNumber(usage.inputTokens)}`, `out ${compactNumber(usage.outputTokens)}`];
    details.push(`task ${compactNumber(usage.totalTokens)} tokens (${tokenParts.join(", ")})`);
  }
  const outputRate = state.session.outputTokensPerSecond;
  if (outputRate !== undefined && outputRate > 0) details.push(`${formatRate(outputRate)} output tok/s`);
  return { text: details.join(" · "), tone };
}

function currentTaskMessages(state: TuiState): readonly TranscriptMessage[] {
  if (state.activeTaskId) {
    const taskMessages = state.transcript.filter(
      (message) =>
        (message.kind === "assistant" || message.kind === "thought" || message.kind === "tool") &&
        message.taskId === state.activeTaskId,
    );
    if (taskMessages.length > 0) return taskMessages;
  }
  const lastUserIndex = latestUserMessageIndex(state);
  return lastUserIndex < 0 ? [] : state.transcript.slice(lastUserIndex + 1);
}

function latestUserMessageIndex(state: TuiState): number {
  for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
    const message = state.transcript[index];
    if (message?.kind === "user" && !message.queued) return index;
  }
  return -1;
}

/**
 * Session usage, with subagent work folded in. The completion summary above the composer is the
 * other scope on screen, so this chip names its own: "session" here, "task" there.
 */
function usageLabel(state: TuiState): string | undefined {
  const main = state.session.usage;
  const agents = state.session.subagentUsage;
  const inputTokens = main.inputTokens + agents.inputTokens;
  const outputTokens = main.outputTokens + agents.outputTokens;
  const cacheReadTokens = main.cacheReadTokens + agents.cacheReadTokens;
  const cacheWriteTokens = main.cacheWriteTokens + agents.cacheWriteTokens;
  if (inputTokens <= 0 && outputTokens <= 0) return undefined;
  const parts = [`in ${compactNumber(inputTokens)}`, `out ${compactNumber(outputTokens)}`];
  if (cacheReadTokens > 0) parts.push(cacheReadLabel(cacheReadTokens, inputTokens));
  if (cacheWriteTokens > 0) parts.push(`write ${compactNumber(cacheWriteTokens)}`);
  // tok/s is deliberately absent: it is a per-turn figure and the completion summary owns it.
  // Brackets group the counts together, so they read as one block next to the single-value chips.
  return `session [${parts.join(" · ")}]`;
}

/** How much of that session total came from subagents; hidden until a subagent has run. */
function subagentUsageChip(state: TuiState): string | undefined {
  const usage = state.session.subagentUsage;
  const tokens = usage.totalTokens > 0 ? usage.totalTokens : usage.inputTokens + usage.outputTokens;
  return tokens > 0 ? `subagents ${compactNumber(tokens)}` : undefined;
}

/** Keep both the full transcript and recent-activity entry points discoverable. */
function detailsHint(state: TuiState): string | undefined {
  const hasActivity = state.transcript.some((message) => message.kind === "thought" || message.kind === "tool");
  return hasActivity ? "ctrl+o transcript · ctrl+t latest" : undefined;
}

function cacheReadLabel(cacheReadTokens: number, inputTokens: number): string {
  const ratio =
    inputTokens > 0 ? Math.max(0, Math.min(100, Math.round((cacheReadTokens / inputTokens) * 100))) : undefined;
  return ratio === undefined
    ? `cache ${compactNumber(cacheReadTokens)}`
    : `cache ${compactNumber(cacheReadTokens)} (${ratio}%)`;
}

function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** Keep the active approval mode visible, including the default Auto mode. */
function permissionChip(state: TuiState): string | undefined {
  const mode = state.session.permissionMode;
  if (!mode) return undefined;
  return `perm:${PERMISSION_MODE_LABELS[mode]}`;
}

/** Context-usage percentage indicator (estimated); at ≥80% it appends a "!" to hint at wrapping up. */
function contextChip(state: TuiState): string | undefined {
  const estimate = state.session.contextEstimate;
  const window = state.session.contextWindow;
  if (!window || window <= 0) return undefined;
  if (estimate === undefined) return undefined;
  const percent = Math.min(99, Math.round((Math.max(0, estimate) / window) * 100));
  return percent >= 80 ? `ctx ${percent}%!` : `ctx ${percent}%`;
}

function explicitStatus(state: TuiState): string | undefined {
  const raw = (state.session.status || "").trim();
  if (isSessionBusy(state) && !raw.startsWith("Permission:")) return undefined;
  if (!raw) return undefined;
  // Suppress noisy machine states; keep user-facing hints (exit, errors, renames).
  // Duration already appears as "- Work for ..." above the composer.
  const lower = raw.toLowerCase();
  if (["ready", "completed", "planning", "executing", "cancelled", "failed"].includes(lower)) return undefined;
  if (lower.startsWith("completed in")) return undefined;
  if (lower === "task completed" || lower === "task completed." || lower.startsWith("task completed")) return undefined;
  return raw;
}
