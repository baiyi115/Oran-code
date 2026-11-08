import type { TuiBackgroundTask } from "./types.js";
import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible } from "./text-width.js";
import { dimHorizontalRule } from "./theme.js";
import { formatDuration } from "../formatting.js";

/**
 * Rendering for the /tasks overlay: every background task the session still knows about, including
 * ones that left the inline panel long ago. The panel is a live indicator with a 60-second linger;
 * this list is where history stays reachable.
 */
export function taskListLines(
  tasks: readonly TuiBackgroundTask[],
  selectedIndex: number,
  width: number,
  now = Date.now(),
): OverlayLine[] {
  const available = Math.max(1, width);
  const lines: OverlayLine[] = [
    overlayLine(truncateVisible(`Tasks · ${tasks.length}`, available)),
    overlayLine(dimHorizontalRule(available)),
    overlayLine(truncateVisible("↑↓ Select   Enter View output   Esc Close", available)),
    overlayLine(""),
  ];
  if (!tasks.length) lines.push(overlayLine("  (no background tasks)"));
  tasks.forEach((task, index) => {
    lines.push(
      highlightSelection(`  ${taskListLabel(task, Math.max(1, available - 2), now)}`, index === selectedIndex),
    );
  });
  return lines;
}

function taskListLabel(task: TuiBackgroundTask, width: number, now: number): string {
  const icon =
    task.status === "completed"
      ? "✓"
      : task.status === "running"
        ? "●"
        : task.status === "queued"
          ? "…"
          : task.status === "idle"
            ? "○"
            : "✗";
  const role = task.definitionName ?? (task.kind === "job" ? "job" : "");
  const startedAt = Date.parse(task.startedAt);
  const endedAt = task.endedAt ? Date.parse(task.endedAt) : now;
  const duration = Number.isFinite(startedAt) ? formatDuration(Math.max(0, endedAt - startedAt)) : "";
  const metadata = [task.id, task.status, duration].filter(Boolean).join(" · ");
  const prefix = `${icon} `;
  const label = role ? `${task.name} · ${role}` : task.name;
  const budget = Math.max(8, width - prefix.length - metadata.length - 2);
  return `${prefix}${truncateVisible(label.replace(/\s+/g, " ").trim(), budget)}  ${metadata}`;
}

/**
 * Body of the details view opened from the list. The transcript's background notification cuts a
 * long result off; this shows what the task actually produced.
 */
export function taskDetailLines(task: TuiBackgroundTask): string[] {
  const started = Date.parse(task.startedAt);
  const ended = task.endedAt ? Date.parse(task.endedAt) : undefined;
  const duration =
    Number.isFinite(started) && ended !== undefined && Number.isFinite(ended)
      ? formatDuration(Math.max(0, ended - started))
      : undefined;
  const header = [
    `${task.id} · ${task.kind === "job" ? "shell job" : task.origin?.kind === "teammate" ? "teammate" : "subagent"}`,
    [task.status, duration].filter(Boolean).join(" · "),
  ];
  if (task.definitionName) header.push(`role: ${task.definitionName}`);
  const body = (task.output ?? "").replace(/\r\n/g, "\n").trim();
  const reason = (task.error ?? "").trim();
  const sections = [header.join("\n")];
  if (reason) sections.push(`error:\n${reason}`);
  sections.push(body || "(no output was recorded)");
  return sections.join("\n\n").split("\n");
}
