import type { TuiState } from "./types.js";

/** Braille spinner frames, matching common CLI working indicators (pi/Ink loaders). */
export const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  const frames = WORKING_SPINNER_FRAMES;
  const index = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
  return frames[index] ?? frames[0]!;
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
 * Live "working" line rendered above the composer while a task is active.
 * Example: "⠋ Working... 2.4s" or "⠋ Running Bash 1.1s".
 */
export function workingIndicatorLine(state: TuiState, tick: number, now = Date.now()): string | undefined {
  if (!isSessionBusy(state)) return undefined;
  // Between assistant_start and the first chunk/thought/tool, fill the gap
  // with a waiting spinner so the working line never goes blank.
  if (state.waitingForFirstChunk) {
    const frame = spinnerFrame(tick);
    const elapsed = formatWorkingElapsed(state, now);
    return elapsed ? `${frame} Waiting... ${elapsed}` : `${frame} Waiting...`;
  }
  // Thought, assistant, and tool rows already carry their own live state.
  // A second spinner duplicates the same information and forces frequent
  // full-frame Ink updates while content is streaming.
  if (hasVisibleLiveActivity(state)) return undefined;
  const frame = spinnerFrame(tick);
  const label = workingLabel(state);
  const elapsed = formatWorkingElapsed(state, now);
  return elapsed ? `${frame} ${label} ${elapsed}` : `${frame} ${label}`;
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

  const runningTool = [...state.transcript].reverse().find((message) => message.kind === "tool" && message.status === "running");
  if (runningTool && runningTool.kind === "tool") {
    return `Running ${toolDisplayName(runningTool.name)}`;
  }
  if (state.session.currentTool) {
    return `Running ${toolDisplayName(state.session.currentTool)}`;
  }

  const thoughtStreaming = state.transcript.some((message) => message.kind === "thought" && message.streaming);
  if (thoughtStreaming || state.thoughtMessageId) return "Thinking...";

  const assistantStreaming = state.streaming || state.transcript.some((message) => message.kind === "assistant" && message.streaming);
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

function toolDisplayName(name: string): string {
  switch (name) {
    case "read_file": return "Read";
    case "write_file": return "Write";
    case "edit_file": return "Edit";
    case "apply_patch": return "Write";
    case "apply_diff": return "Patch";
    case "run_command": return "Bash";
    case "glob_files": return "Glob";
    case "search_code": return "Search";
    case "list_files": return "List";
    case "git_status": return "GitStatus";
    case "get_diff": return "Diff";
    default: return name;
  }
}
