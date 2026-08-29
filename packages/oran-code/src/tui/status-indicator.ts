import type { TuiBackgroundTask, TuiState } from "./types.js";
import { toolDisplayName } from "./tool-names.js";

/** Braille spinner frames, matching common CLI working indicators (pi/Ink loaders). */
export const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  const frames = WORKING_SPINNER_FRAMES;
  const index = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
  return frames[index] ?? frames[0]!;
}

export function hasActiveBackgroundTasks(state: TuiState): boolean {
  return (state.session.backgroundTasks ?? []).some((task) => task.status === "running" || task.status === "queued");
}

export function isSessionBusy(state: TuiState): boolean {
  const taskState = String(state.session.taskState);
  if (["planning", "executing", "verifying", "awaiting_approval"].includes(taskState)) return true;
  if (state.streaming) return true;
  if (state.thoughtMessageId) return true;
  if (state.session.currentTool) return true;
  return state.transcript.some((message) => {
    if (message.kind === "tool" && message.status === "running") return true;
    if ((message.kind === "assistant" || message.kind === "thought") && message.streaming) return true;
    return false;
  });
}

/**
 * Formats running background subagent tasks into a concise label.
 * Single: "[Subagent: explore] Searching codebase... 8.4s"
 * Multiple: "[2 subagents running] explore (18.1s), tester (5.2s)"
 */
export function formatBackgroundTasksIndicator(
  tasks: readonly TuiBackgroundTask[],
  now = Date.now(),
): string | undefined {
  const running = tasks.filter((task) => task.status === "running");
  const queued = tasks.filter((task) => task.status === "queued");
  if (running.length === 0 && queued.length === 0) return undefined;

  if (running.length === 1 && queued.length === 0) {
    const task = running[0]!;
    const name =
      task.definitionName ||
      (task.origin?.kind === "definition" ? task.origin.name : undefined) ||
      task.name ||
      "agent";
    const description = task.name && task.name !== name ? task.name : undefined;
    const startTime = Date.parse(task.startedAt);
    const elapsed = Number.isFinite(startTime) ? formatCompactDuration(Math.max(0, now - startTime)) : undefined;
    const parts = [`[Subagent: ${name}]`];
    if (description) parts.push(description);
    if (elapsed) parts.push(elapsed);
    return parts.join(" ");
  }

  if (running.length === 0 && queued.length > 0) {
    return queued.length === 1
      ? `[1 subagent queued: ${queued[0]!.definitionName || queued[0]!.name || "agent"}]`
      : `[${queued.length} subagents queued]`;
  }

  const taskSummaries = running.map((task) => {
    const name =
      task.definitionName ||
      (task.origin?.kind === "definition" ? task.origin.name : undefined) ||
      task.name ||
      "agent";
    const startTime = Date.parse(task.startedAt);
    const elapsed = Number.isFinite(startTime) ? formatCompactDuration(Math.max(0, now - startTime)) : undefined;
    return elapsed ? `${name} (${elapsed})` : name;
  });

  const queuedSuffix = queued.length > 0 ? ` (+${queued.length} queued)` : "";
  return `[${running.length} subagents running${queuedSuffix}] ${taskSummaries.join(", ")}`;
}

/**
 * Live "working" line rendered above the composer while a task is active.
 * Example: "⠋ Working... 2.4s" or "⠋ Running Bash 1.1s" or "⠋ [Subagent: explore] 8.4s".
 */
export function workingIndicatorLine(state: TuiState, tick: number, now = Date.now()): string | undefined {
  const frame = spinnerFrame(tick);
  const bgTasks = state.session.backgroundTasks ?? [];
  const bgIndicator = formatBackgroundTasksIndicator(bgTasks, now);

  if (!isSessionBusy(state)) {
    if (bgIndicator) {
      return `${frame} ${bgIndicator}`;
    }
    return undefined;
  }

  // Between assistant_start and the first chunk/thought/tool, fill the gap
  // with a waiting spinner so the working line never goes blank.
  if (state.waitingForFirstChunk) {
    const elapsed = formatWorkingElapsed(state, now);
    const mainText = elapsed ? `Waiting... ${elapsed}` : "Waiting...";
    return bgIndicator ? `${frame} ${mainText} · ${bgIndicator}` : `${frame} ${mainText}`;
  }
  // Thought, assistant, and tool rows already carry their own live state.
  // A second spinner duplicates the same information and forces frequent
  // full-frame Ink updates while content is streaming.
  if (hasVisibleLiveActivity(state)) {
    if (bgIndicator) {
      return `${frame} ${bgIndicator}`;
    }
    return undefined;
  }
  const label = workingLabel(state);
  const elapsed = formatWorkingElapsed(state, now);
  const mainText = elapsed ? `${label} ${elapsed}` : label;
  return bgIndicator ? `${frame} ${mainText} · ${bgIndicator}` : `${frame} ${mainText}`;
}

function hasVisibleLiveActivity(state: TuiState): boolean {
  return state.transcript.some((message) => {
    if (message.kind === "tool") return message.status === "running";
    if (message.kind === "thought") return message.streaming === true;
    if (message.kind === "assistant") return message.streaming === true;
    return false;
  });
}

function workingLabel(state: TuiState): string {
  if (state.session.taskState === "awaiting_approval") return "Waiting for approval...";
  if (state.session.taskState === "verifying") return "Verifying...";
  if (state.session.taskState === "planning") return "Planning...";

  const runningTool = [...state.transcript]
    .reverse()
    .find((message) => message.kind === "tool" && message.status === "running");
  if (runningTool && runningTool.kind === "tool") {
    return `Running ${toolDisplayName(runningTool.name)}`;
  }
  if (state.session.currentTool) {
    return `Running ${toolDisplayName(state.session.currentTool)}`;
  }

  const thoughtStreaming = state.transcript.some((message) => message.kind === "thought" && message.streaming);
  if (thoughtStreaming || state.thoughtMessageId) return "Thinking...";

  const assistantStreaming =
    state.streaming || state.transcript.some((message) => message.kind === "assistant" && message.streaming);
  if (assistantStreaming) return "Writing...";

  if (state.session.taskState === "executing") return "Working...";
  return "Working...";
}

function formatWorkingElapsed(state: TuiState, now: number): string | undefined {
  const startedAt = state.session.startedAt;
  if (startedAt === undefined) return undefined;
  const elapsedMs = Math.max(0, now - startedAt);
  return formatCompactDuration(elapsedMs);
}

export function formatCompactDuration(value: number): string {
  const ms = Math.max(0, Math.round(value));
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}
