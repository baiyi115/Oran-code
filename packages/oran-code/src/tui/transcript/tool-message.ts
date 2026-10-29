import type { ToolMessage } from "../types.js";
import { formatDuration } from "../../formatting.js";
import { renderDiff } from "./diff-renderer.js";
import { truncateVisible, visibleWidth, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";
import { spinnerFrame } from "../status-indicator.js";
import { toolDisplayName } from "../tool-names.js";

export function renderToolMessage(message: ToolMessage, width: number, liveTick = 0, now = Date.now()): string[] {
  const indicator =
    message.status === "running"
      ? spinnerFrame(liveTick)
      : message.status === "success"
        ? "◇"
        : message.status === "failure"
          ? "×"
          : message.status === "rejected"
            ? "!"
            : "-";
  const label = toolDisplayName(message.name);
  const argument = toolArgumentSummary(message);
  const call = argument
    ? `${ANSI.toolBold}${label}${ANSI.reset} ${ANSI.gray}${argument}${ANSI.reset}`
    : `${ANSI.toolBold}${label}${ANSI.reset}`;
  // What the call changed, in the heading: the counts answer "how big was this edit" without
  // opening the row, and they stay correct even when the diff text below is truncated.
  const changeDiff = writeToolDiff(message);
  const changeCounts = changeDiff ? diffCounters(changeDiff) : "";
  // A finished call shows its total duration; a running one shows elapsed time (so a long tool's
  // stuck step is visible at a glance).
  const duration =
    message.durationMs !== undefined
      ? `  ${ANSI.gray}${formatDuration(message.durationMs)}${ANSI.reset}`
      : message.status === "running" && message.startedAt
        ? `  ${ANSI.gray}${formatDuration(Math.max(0, now - Date.parse(message.startedAt)))}${ANSI.reset}`
        : "";
  const badges =
    message.badges && message.badges.length ? `  ${ANSI.gray}[${message.badges.join(", ")}]${ANSI.reset}` : "";
  const status =
    message.status === "running" || message.status === "success"
      ? ""
      : `  ${message.status === "failure" || message.status === "rejected" ? ANSI.redBold : ANSI.amberBold}${message.status}${ANSI.reset}`;
  const indicatorColor =
    message.status === "failure" || message.status === "rejected"
      ? ANSI.redBold
      : message.status === "success"
        ? ANSI.greenBold
        : ANSI.orangeBold;
  // A running call has no summary yet; a progress note stands in, so a long tool
  // (a cold code-graph build) says what it is doing instead of only how long it
  // has been at it. The result summary takes over as soon as it lands.
  const detail = message.summary || message.error || message.progress || "";
  const summary =
    detail && (message.status !== "success" || shouldShowSuccessSummary(detail))
      ? ` ${ANSI.gray}\u00b7 ${truncateVisible(detail.replace(/\s+/g, " ").trim(), 80)}${ANSI.reset}`
      : "";
  const headingPrefix = `${indicatorColor}${indicator}${ANSI.reset} `;
  const headingBody = `${call}${changeCounts}${status}${duration}${summary}${badges}`;
  const headingWidth = Math.max(1, width - visibleWidth(headingPrefix));
  const lines = wrapDisplayText(headingBody, headingWidth).map(
    (line, index) => `${index === 0 ? headingPrefix : " ".repeat(2)}${line}`,
  );
  const output = message.error || message.output || "";
  if (message.expanded && output && !changeDiff?.text) {
    // Showing only the first 12 lines drops the valuable part of long output (failure stacks and
    // summary lines almost always sit at the end), so it became "8 head lines + an omission
    // marker + 4 tail lines"; head and tail stay visible, ctrl+t gives the detail.
    const preview = output.split(/\r?\n/).filter(Boolean);
    const HEAD = 8;
    const TAIL = 4;
    const shown =
      preview.length <= HEAD + TAIL ? preview : [...preview.slice(0, HEAD), undefined, ...preview.slice(-TAIL)];
    for (const line of shown) {
      if (line === undefined) {
        lines.push(
          `${ANSI.gray}  \u2502 ... ${preview.length - HEAD - TAIL} lines hidden (PageUp/PageDown in details) ...${ANSI.reset}`,
        );
        continue;
      }
      lines.push(...wrapDisplayText(`\u2502 ${line}`, Math.max(1, width - 2)).map((wrapped) => `  ${wrapped}`));
    }
  } else if (output && message.status !== "success" && output.trim() !== detail.trim()) {
    const error = truncateVisible(output.replace(/\s+/g, " ").trim(), Math.max(40, width * 2));
    lines.push(
      ...wrapDisplayText(`\u2502 ${error}`, Math.max(1, width - 2))
        .map((wrapped) => `  ${wrapped}`)
        .slice(0, 2),
    );
  }
  // The heading already says how big the edit was (+N -M); the diff body itself only renders in the
  // details view. Padding every finished write with a few preview lines pushes the conversation
  // apart for something the counts already answer, and a write is never folded into "N tools".
  if (changeDiff?.text && message.expanded) lines.push(...renderDiff(changeDiff.text, width));
  return lines;
}

/** Diff text plus its change counts; `text` is absent when only the counts are known. */
interface DisplayDiff {
  text?: string | undefined;
  added: number;
  removed: number;
}

function diffCounters(diff: DisplayDiff): string {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`${ANSI.green}+${diff.added}${ANSI.reset}`);
  if (diff.removed > 0) parts.push(`${ANSI.red}-${diff.removed}${ANSI.reset}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * What the call changed: the diff the tool actually applied when it reported one, else a preview
 * derived from the call's arguments (older sessions, and any writer that does not report a diff),
 * and undefined for read-only tools.
 */
function writeToolDiff(message: ToolMessage): DisplayDiff | undefined {
  // Failed, rejected, cancelled, and running calls did not produce a confirmed
  // file change, so do not present their requested arguments as an applied diff.
  if (message.status !== "success") return undefined;
  // A reported diff is authoritative even when empty: the writer knows there was nothing worth
  // showing, and falling back to the arguments would claim a whole-file addition for an overwrite.
  if (message.diff) {
    return {
      text: message.diff.text || undefined,
      added: message.diff.added,
      removed: message.diff.removed,
    };
  }
  const text = argumentDiff(message);
  if (!text) return undefined;
  return { text, ...countDiffLines(text) };
}

/** Diff preview reconstructed from the call arguments; has no before-state to compare against. */
function argumentDiff(message: ToolMessage): string | undefined {
  if (message.name === "edit_file") {
    if (Array.isArray(message.arguments.edits)) {
      const diffs: string[] = [];
      for (const edit of message.arguments.edits as Array<Record<string, unknown>>) {
        const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
        const newString = typeof edit.new_string === "string" ? edit.new_string : "";
        if (!oldString && !newString) continue;
        const removals = oldString.split(/\r?\n/).map((line) => `-${line}`);
        const additions = newString.split(/\r?\n/).map((line) => `+${line}`);
        diffs.push([...removals, ...additions].join("\n"));
      }
      return diffs.length > 0 ? diffs.join("\n") : undefined;
    }
    const oldString = typeof message.arguments.old_string === "string" ? message.arguments.old_string : "";
    const newString = typeof message.arguments.new_string === "string" ? message.arguments.new_string : "";
    if (!oldString && !newString) return undefined;
    const removals = oldString.split(/\r?\n/).map((line) => `-${line}`);
    const additions = newString.split(/\r?\n/).map((line) => `+${line}`);
    return [...removals, ...additions].join("\n");
  }
  if (message.name === "apply_patch") {
    const diff = typeof message.arguments.diff === "string" ? message.arguments.diff : "";
    return diff.trim() ? diff : undefined;
  }
  if (message.name === "write_file") {
    const content = typeof message.arguments.content === "string" ? message.arguments.content : "";
    if (!content.trim()) return undefined;
    return content
      .split(/\r?\n/)
      .map((line) => `+${line}`)
      .join("\n");
  }
  return undefined;
}

/** Added/removed line counts from diff text, ignoring hunk and file headers. */
function countDiffLines(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function toolArgumentSummary(message: ToolMessage): string {
  // The description argument of agent/team_spawn is what this subagent is doing; without it,
  // parallel subagents render as indistinguishable rows of agent + seconds.
  if (message.name === "agent" || message.name === "team_spawn") {
    const role = stringArgument(message.arguments.subagent_type) ?? stringArgument(message.arguments.team_name);
    const description = stringArgument(message.arguments.description);
    if (role && description) return truncateVisible(`${role} · ${description}`, 72);
    if (description) return truncateVisible(description, 72);
  }
  if (message.name === "read_file") {
    const path = typeof message.arguments.path === "string" ? message.arguments.path.trim() : "";
    const offset = integerArgument(message.arguments.offset, 1);
    const limit = integerArgument(message.arguments.limit, 200);
    const range = limit > 0 ? `L${offset}\u2013${offset + limit - 1}` : `L${offset}`;
    if (path) return truncateVisible(`${path} ${range}`, 72);
  }
  for (const key of ["path", "command", "pattern", "glob", "old_string", "workspace"]) {
    const value = message.arguments[key];
    if (typeof value === "string" && value.trim()) return truncateVisible(value.replace(/\s+/g, " ").trim(), 72);
  }
  return "";
}

function stringArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function integerArgument(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function shouldShowSuccessSummary(detail: string): boolean {
  const text = detail.trim();
  if (!text) return false;
  return text !== "ok";
}
