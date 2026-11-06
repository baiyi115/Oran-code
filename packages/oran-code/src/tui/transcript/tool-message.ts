import type { ToolMessage } from "../types.js";
import { formatDuration } from "../../formatting.js";
import { renderDiff } from "./diff-renderer.js";
import { stripTerminalMarkup, truncateVisible, wrapDisplayText, wrapDisplayTextLimited } from "../text-width.js";
import { ANSI } from "../theme.js";
import { spinnerFrame } from "../status-indicator.js";
import { toolDisplayName } from "../tool-names.js";

export function renderToolMessage(message: ToolMessage, width: number, liveTick = 0, now = Date.now()): string[] {
  const indicator = message.status === "running" ? spinnerFrame(liveTick) : message.status === "cancelled" ? "■" : "●";
  const indicatorColor =
    message.status === "failure" || message.status === "rejected"
      ? ANSI.redBold
      : message.status === "success"
        ? ANSI.greenBold
        : ANSI.orangeBold;
  const label = toolDisplayName(message.name);
  const argument = stripTerminalMarkup(toolArgumentSummary(message));
  const call = argument ? `${label}(${argument})` : label;
  const elapsed =
    message.durationMs ??
    (message.status === "running" && message.startedAt ? Math.max(0, now - Date.parse(message.startedAt)) : undefined);
  const duration = elapsed !== undefined ? ` · ${formatDuration(elapsed)}` : "";
  const status = message.status === "running" || message.status === "success" ? "" : ` · ${message.status}`;
  const badges = message.badges?.length ? ` [${message.badges.join(", ")}]` : "";
  const lines = wrapDisplayText(call, Math.max(1, width - 2)).map((line, index) =>
    index === 0 ? `${indicatorColor}${indicator}${ANSI.reset} ${ANSI.bold}${line}${ANSI.reset}` : `  ${line}`,
  );
  const bodyWidth = Math.max(1, width - 4);
  const appendDetail = (text: string): void => {
    wrapDisplayText(text, bodyWidth).forEach((line, index) => {
      lines.push(`  ${ANSI.gray}${index === 0 ? "└ " : "  "}${line}${ANSI.reset}`);
    });
  };
  if (status || badges || message.status === "running") {
    appendDetail(`${message.status === "running" ? "Running" : message.status}${duration}${badges}`);
  }
  const changeDiff = writeToolDiff(message);
  const detail = message.summary || message.error || message.progress || "";
  if (changeDiff) {
    appendDetail(`${diffCounters(changeDiff)}${duration}`);
    if (changeDiff.text) {
      const diffLines = renderDiff(changeDiff.text, bodyWidth);
      const shown = message.expanded ? diffLines : diffLines.slice(0, 8);
      lines.push(...shown.map((line) => `    ${line}`));
      if (shown.length < diffLines.length)
        appendDetail(`… +${diffLines.length - shown.length} diff rows (ctrl+o details)`);
      if (message.diff?.truncated) appendDetail("Diff truncated by tool; use get_diff for the remaining changes");
    }
  } else {
    if (message.error && message.error !== detail && message.error !== message.output) appendDetail(message.error);
    const output = message.output || message.error || "";
    const hasDetail = Boolean(
      detail && detail.trim() !== output.trim() && (message.status !== "success" || detail.trim() !== "ok"),
    );
    if (hasDetail) {
      appendDetail(
        `${truncateVisible(stripTerminalMarkup(detail).replace(/\s+/g, " ").trim(), 160)}${message.status === "success" ? duration : ""}`,
      );
    }
    // Preserve command output alongside its error; failure summaries must not hide the useful log.
    if (output.trim()) {
      lines.push(...renderOutputPreview(output, bodyWidth, message.expanded, message.status === "failure", !hasDetail));
    } else if (!hasDetail && message.status === "success") {
      appendDetail(`Completed${duration}`);
    }
  }
  return lines;
}

function renderOutputPreview(
  output: string,
  width: number,
  expanded: boolean,
  failed: boolean,
  connector: boolean,
): string[] {
  const source = stripTerminalMarkup(output).replace(/\r\n/g, "\n").trimEnd().split("\n");
  const limit = expanded ? 400 : 3;
  const head = failed && source.length > limit ? limit - 1 : limit;
  const shown: Array<string | undefined> =
    source.length <= limit ? source : [...source.slice(0, head), undefined, ...(failed ? source.slice(-1) : [])];
  const lines: string[] = [];
  let clipped = false;
  for (const line of shown) {
    const text =
      line === undefined
        ? `… +${source.length - limit} lines (${expanded ? "output truncated" : "ctrl+o details"})`
        : line;
    const wrapped =
      expanded || line === undefined ? wrapDisplayText(text, width) : wrapDisplayTextLimited(text, width, 2);
    if (!expanded && line !== undefined && wrapped.at(-1) === "…") clipped = true;
    for (const row of wrapped) {
      const prefix = connector && lines.length === 0 ? "  └ " : "    ";
      lines.push(`${prefix}${ANSI.gray}${row}${ANSI.reset}`);
    }
  }
  if (clipped) {
    lines.push(
      ...wrapDisplayText("Long lines shortened (ctrl+o details)", width).map(
        (line) => `    ${ANSI.gray}${line}${ANSI.reset}`,
      ),
    );
  }
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
  if (diff.added > 0) parts.push(`Added ${diff.added} ${diff.added === 1 ? "line" : "lines"}`);
  if (diff.removed > 0) parts.push(`removed ${diff.removed} ${diff.removed === 1 ? "line" : "lines"}`);
  return parts.join(", ") || "No changed lines";
}

/** Prefer the applied diff; old sessions can still reconstruct edit/patch previews. */
function writeToolDiff(message: ToolMessage): DisplayDiff | undefined {
  if (message.status !== "success") return undefined;
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

/** Old tool arguments lack a before-state, so whole-file writes cannot reconstruct a diff. */
function argumentDiff(message: ToolMessage): string | undefined {
  if (message.name === "edit_file") {
    const edits = Array.isArray(message.arguments.edits) ? message.arguments.edits : [message.arguments];
    const diffs: string[] = [];
    for (const edit of edits as Array<Record<string, unknown>>) {
      if (!edit || typeof edit !== "object") continue;
      const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
      const newString = typeof edit.new_string === "string" ? edit.new_string : "";
      if (!oldString && !newString) continue;
      const removals = oldString ? oldString.split(/\r?\n/).map((line) => `-${line}`) : [];
      const additions = newString ? newString.split(/\r?\n/).map((line) => `+${line}`) : [];
      diffs.push([...removals, ...additions].join("\n"));
    }
    return diffs.length > 0 ? diffs.join("\n") : undefined;
  }
  if (message.name === "apply_patch") {
    const diff = typeof message.arguments.diff === "string" ? message.arguments.diff : "";
    return diff.trim() ? diff : undefined;
  }
  return undefined;
}

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
  if (message.name === "agent" || message.name === "team_spawn") {
    const role = stringArgument(message.arguments.subagent_type) ?? stringArgument(message.arguments.team_name);
    const description = stringArgument(message.arguments.description);
    if (role && description) return truncateVisible(`${role} · ${description}`, 100);
    if (description) return truncateVisible(description, 100);
  }
  if (message.name === "read_file") {
    const path = typeof message.arguments.path === "string" ? message.arguments.path.trim() : "";
    const offset = integerArgument(message.arguments.offset, 1);
    const limit = integerArgument(message.arguments.limit, 200);
    if (path) return truncateVisible(`${path}, L${offset}–${offset + limit - 1}`, 100);
  }
  for (const key of ["path", "command", "pattern", "glob", "workspace"]) {
    const value = stringArgument(message.arguments[key]);
    if (value) return truncateVisible(value, 100);
  }
  return "";
}

function stringArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function integerArgument(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}
