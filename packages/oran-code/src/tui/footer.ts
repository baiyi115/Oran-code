import type { TuiState } from "./types.js";
import { abbreviatePath, truncateVisible, visibleWidth } from "./text-width.js";
import { isSessionBusy } from "./status-indicator.js";
import { formatCompactDuration } from "./status-indicator.js";
import { isCasualConversationPrompt } from "../prompt-intent.js";

/**
 * Footer layout (bottom chrome):
 *   auto · high · model
 *   D:\workspace
 *   in 5008/out 239/cacheR 256
 *
 * Context percentage is intentionally omitted.
 */
export function footerLines(state: TuiState, width: number): string[] {
  const available = Math.max(1, Math.floor(width));
  const primary = [
    state.session.workMode,
    state.session.reasoningEffort,
    state.session.modelLabel || "(not selected)",
  ].filter(Boolean).join(" · ");

  const workspace = state.session.workspace || ".";
  const usage = usageLabel(state);
  const queue = state.session.followUpCount > 0 ? `follow-ups: ${state.session.followUpCount}` : undefined;
  const status = explicitStatus(state);

  const detail = [usage, queue, status].filter(Boolean).join(" · ");
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

/** Compact completed-turn summary shown above the composer. */
export function workSummaryLine(state: TuiState): string | undefined {
  if (isSessionBusy(state)) return undefined;
  const elapsed = state.session.elapsedMs;
  if (elapsed === undefined || elapsed <= 0) return undefined;
  if (state.session.taskState === "completed" && !shouldShowCompletedSummary(state)) return undefined;
  const label = state.session.taskState === "failed"
    ? "× Failed"
    : state.session.taskState === "cancelled"
      ? "■ Cancelled"
      : state.session.taskState === "paused"
        ? "■ Paused"
        : "✓ Done";
  return `${label} · ${formatCompactDuration(elapsed)}`;
}

function shouldShowCompletedSummary(state: TuiState): boolean {
  let lastUserIndex = -1;
  for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
    const message = state.transcript[index];
    if (message?.kind === "user" && !message.queued) {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return false;
  const userMessage = state.transcript[lastUserIndex];
  if (userMessage?.kind === "user" && isCasualConversationPrompt(userMessage.text)) return false;
  return state.transcript.slice(lastUserIndex + 1).some((message) => (
    message.kind === "tool" || message.kind === "verification" || message.kind === "plan"
  ));
}

export function formatFooter(state: TuiState, width: number): string {
  return footerLines(state, width).join("\n");
}

function usageLabel(state: TuiState): string | undefined {
  const usage = state.session.usage;
  if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) return undefined;
  const parts = [`in ${compactNumber(usage.inputTokens)}`, `out ${compactNumber(usage.outputTokens)}`];
  if (usage.cacheReadTokens > 0) parts.push(cacheReadLabel(usage.cacheReadTokens, usage.inputTokens));
  if (usage.cacheWriteTokens > 0) parts.push(`write ${compactNumber(usage.cacheWriteTokens)}`);
  return parts.join(" · ");
}

function cacheReadLabel(cacheReadTokens: number, inputTokens: number): string {
  const ratio = inputTokens > 0
    ? Math.max(0, Math.min(100, Math.round((cacheReadTokens / inputTokens) * 100)))
    : undefined;
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

function explicitStatus(state: TuiState): string | undefined {
  if (isSessionBusy(state)) return undefined;
  const raw = (state.session.status || "").trim();
  if (!raw) return undefined;
  // Suppress noisy machine states; keep user-facing hints (exit, errors, renames).
  // Duration already appears as "- Work for ..." above the composer.
  const lower = raw.toLowerCase();
  if (["ready", "completed", "planning", "executing", "verifying", "cancelled", "failed"].includes(lower)) return undefined;
  if (lower.startsWith("completed in")) return undefined;
  if (lower === "task completed" || lower === "task completed." || lower.startsWith("task completed")) return undefined;
  return raw;
}

export function footerWidth(value: string): number {
  return visibleWidth(value);
}
