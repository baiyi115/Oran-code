import type { TuiBackgroundTask, TuiState } from "./types.js";
import { toolDisplayName } from "./tool-names.js";
import { truncateVisible } from "./text-width.js";
import { formatDuration } from "../formatting.js";
import { isLiveMessage } from "./transcript/live-message.js";

/** Braille spinner frames, matching common CLI working indicators (pi/Ink loaders). */
const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  const frames = WORKING_SPINNER_FRAMES;
  const index = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
  return frames[index] ?? frames[0]!;
}

export function hasActiveBackgroundTasks(state: TuiState): boolean {
  return (state.session.backgroundTasks ?? []).some((task) => task.status === "running" || task.status === "queued");
}

/** The slices of the background-task list the footer and the panels all ask for. */
export interface BackgroundTaskPartition {
  readonly subagents: readonly TuiBackgroundTask[];
  readonly jobs: readonly TuiBackgroundTask[];
  readonly runningSubagents: readonly TuiBackgroundTask[];
  readonly queuedSubagents: readonly TuiBackgroundTask[];
  readonly runningJobs: readonly TuiBackgroundTask[];
}

/** One pass over the list instead of a filter per consumer. */
export function partitionBackgroundTasks(tasks: readonly TuiBackgroundTask[] = []): BackgroundTaskPartition {
  const subagents: TuiBackgroundTask[] = [];
  const jobs: TuiBackgroundTask[] = [];
  const runningSubagents: TuiBackgroundTask[] = [];
  const queuedSubagents: TuiBackgroundTask[] = [];
  const runningJobs: TuiBackgroundTask[] = [];
  for (const task of tasks) {
    if (task.kind === "job") {
      jobs.push(task);
      if (task.status === "running") runningJobs.push(task);
      continue;
    }
    subagents.push(task);
    if (task.status === "running") runningSubagents.push(task);
    else if (task.status === "queued") queuedSubagents.push(task);
  }
  return { subagents, jobs, runningSubagents, queuedSubagents, runningJobs };
}

export function isSessionBusy(state: TuiState): boolean {
  const taskState = String(state.session.taskState);
  if (["planning", "executing", "awaiting_approval"].includes(taskState)) return true;
  if (state.streaming) return true;
  if (state.thoughtMessageId) return true;
  if (state.session.currentTool) return true;
  return state.transcript.some(isLiveMessage);
}

/** Color semantics for the subagent task panel (the render layer maps them to COLORS). */
export type TaskPanelTone = "running" | "queued" | "done" | "failed";

export interface TaskPanelRow {
  readonly text: string;
  readonly tone: TaskPanelTone;
}

/** Max rows the panel renders; older tasks collapse into "+N more". */
export const TASK_PANEL_MAX_ROWS = 6;
/** How long a just-finished subagent lingers in the panel (so "just done/just failed" is visible). */
export const TASK_PANEL_RECENT_DONE_MS = 60_000;

/**
 * Per-task subagent panel below the input box (Claude Code style): one row per background
 * subagent, with a status icon, role·task description and a timing convention (running=elapsed
 * so far, finished=total duration). Shell jobs are not here; the status line's jobs badge
 * covers those.
 */
export function subagentTaskLines(
  tasks: readonly TuiBackgroundTask[],
  tick = 0,
  now = Date.now(),
  width = 80,
  maxRows = TASK_PANEL_MAX_ROWS,
): TaskPanelRow[] {
  const subagents = partitionBackgroundTasks(tasks).subagents;
  if (subagents.length === 0) return [];
  const isActive = (task: TuiBackgroundTask): boolean => task.status === "running" || task.status === "queued";
  const active = subagents.filter(isActive);
  const finished = subagents.filter((task) => {
    if (isActive(task)) return false;
    const endedAt = task.endedAt ? Date.parse(task.endedAt) : Number.NaN;
    return Number.isFinite(endedAt) && now - endedAt <= TASK_PANEL_RECENT_DONE_MS;
  });
  const ordered = [...active, ...finished];
  if (ordered.length === 0) {
    // Nothing running and nothing recent: the finished tasks have left the panel, but they are
    // still in the task list. Keep one row so the history stays reachable instead of just vanishing.
    const failed = subagents.filter((task) => task.status !== "completed").length;
    const detail = failed > 0 ? `${subagents.length - failed} done · ${failed} failed` : `${subagents.length} finished`;
    return [{ text: `${failed > 0 ? "✗" : "✓"} ${detail} · /tasks to review`, tone: failed > 0 ? "failed" : "done" }];
  }

  const rowLimit = Math.max(1, Math.floor(maxRows));
  // The "+N more" row occupies a line itself, so the hidden count is computed against limit-1.
  const hidden = ordered.length > rowLimit ? ordered.length - (rowLimit - 1) : 0;
  const visible = hidden > 0 ? ordered.slice(0, rowLimit - 1) : ordered;
  const rows = visible.map((task) => buildTaskPanelRow(task, tick, now, width));
  // ctrl+t opens the "recent activity" details, which cannot show tasks collapsed into that row;
  // /tasks is the entry point listing every background task, so the hint must point there.
  if (hidden > 0) rows.push({ text: `… +${hidden} more (/tasks for all)`, tone: "queued" });
  return rows;
}

function buildTaskPanelRow(task: TuiBackgroundTask, tick: number, now: number, width: number): TaskPanelRow {
  const role =
    task.definitionName || (task.origin?.kind === "definition" ? task.origin.name : task.origin?.kind) || undefined;
  const label = role && role !== task.name ? `${role} · ${task.name}` : task.name || "agent";
  const startedAt = Date.parse(task.startedAt);
  const endedAt = task.endedAt ? Date.parse(task.endedAt) : Number.NaN;

  let icon: string;
  let timing: string;
  let tone: TaskPanelTone;
  if (task.status === "running") {
    icon = spinnerFrame(tick);
    tone = "running";
    timing = Number.isFinite(startedAt) ? formatDuration(Math.max(0, now - startedAt)) : "running";
  } else if (task.status === "queued") {
    icon = "…";
    tone = "queued";
    timing = "queued";
  } else {
    icon = task.status === "completed" ? "✓" : "✗";
    tone = task.status === "completed" ? "done" : "failed";
    const total =
      Number.isFinite(startedAt) && Number.isFinite(endedAt)
        ? ` ${formatDuration(Math.max(0, endedAt - startedAt))}`
        : "";
    timing = `${task.status}${total}`;
  }
  // Keep the timing suffix alive: a long description only truncates the label part.
  // A failed subagent also says why, which is the part the user needs to decide what to do next.
  const reason =
    task.status === "failed" && task.error
      ? truncateVisible(task.error.split(/\r?\n/)[0]?.trim() ?? "", Math.max(8, Math.floor(width * 0.4)))
      : "";
  const suffix = ` · ${timing}${reason ? ` · ${reason}` : ""}`;
  const prefix = `${icon} `;
  const budget = Math.max(8, width - prefix.length - suffix.length);
  return { text: `${prefix}${truncateVisible(label.replace(/\s+/g, " ").trim(), budget)}${suffix}`, tone };
}

/** Live indicator for background shell jobs (dev server / build): counted and worded apart from subagents. */
function formatBackgroundJobsIndicator(tasks: readonly TuiBackgroundTask[], now = Date.now()): string | undefined {
  const running = partitionBackgroundTasks(tasks).runningJobs;
  if (running.length === 0) return undefined;
  const first = running[0]!;
  const startTime = Date.parse(first.startedAt);
  const elapsed = Number.isFinite(startTime) ? formatDuration(Math.max(0, now - startTime)) : undefined;
  const command = first.name.length > 40 ? `${first.name.slice(0, 39)}…` : first.name;
  const parts = [
    running.length === 1 ? `[1 background job: ${command}]` : `[${running.length} background jobs running]`,
  ];
  if (elapsed) parts.push(elapsed);
  return parts.join(" ");
}

/**
 * Live "working" line rendered above the composer while a task is active.
 * Example: "⠋ Working... 2.4s" or "⠋ Running Bash 1.1s". Subagent progress belongs to the
 * per-task panel below the input box; only the shell-job badge is kept here.
 */
export function workingIndicatorLine(state: TuiState, tick: number, now = Date.now()): string | undefined {
  const frame = spinnerFrame(tick);
  const bgTasks = state.session.backgroundTasks ?? [];
  const bgIndicator = formatBackgroundJobsIndicator(bgTasks, now);
  // An armed Esc rides on this line: the footer suppresses statuses while a task runs, and this is
  // the row the user is already looking at while waiting.
  const cancelHint =
    state.cancelArmedUntil !== undefined && now < state.cancelArmedUntil ? "Esc again to cancel" : undefined;
  const withHint = (line: string | undefined): string | undefined => {
    if (!cancelHint) return line;
    return line ? `${line} · ${cancelHint}` : `${frame} ${cancelHint}`;
  };

  if (!isSessionBusy(state)) {
    if (bgIndicator) {
      return withHint(`${frame} ${bgIndicator}`);
    }
    return undefined;
  }

  // Between assistant_start and the first chunk/thought/tool, fill the gap
  // with a waiting spinner so the working line never goes blank.
  if (state.waitingForFirstChunk) {
    const elapsed = formatWorkingElapsed(state, now);
    const mainText = elapsed ? `Waiting... ${elapsed}` : "Waiting...";
    return withHint(bgIndicator ? `${frame} ${mainText} · ${bgIndicator}` : `${frame} ${mainText}`);
  }
  // Thought, assistant, and tool rows already carry their own live state.
  // A second spinner duplicates the same information and forces frequent
  // full-frame Ink updates while content is streaming.
  if (hasVisibleLiveActivity(state)) {
    if (bgIndicator) {
      return withHint(`${frame} ${bgIndicator}`);
    }
    return withHint(undefined);
  }
  const label = workingLabel(state);
  const elapsed = formatWorkingElapsed(state, now);
  const mainText = elapsed ? `${label} ${elapsed}` : label;
  return withHint(bgIndicator ? `${frame} ${mainText} · ${bgIndicator}` : `${frame} ${mainText}`);
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
  if (state.session.taskState === "planning") return "Planning...";

  const runningTool = [...state.transcript]
    .reverse()
    .find((message) => message.kind === "tool" && message.status === "running");
  if (runningTool && runningTool.kind === "tool") {
    const note = runningTool.progress;
    return `Running ${toolDisplayName(runningTool.name)}${note ? ` · ${truncateVisible(note, 60)}` : ""}`;
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
  return formatDuration(elapsedMs);
}
