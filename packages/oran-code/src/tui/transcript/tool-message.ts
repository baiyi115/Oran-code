import type { ToolMessage } from "../types.js";
import { renderDiff } from "./diff-renderer.js";
import { stripTerminalMarkup, truncateVisible, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";
import { spinnerFrame } from "../status-indicator.js";

export function renderToolMessage(message: ToolMessage, width: number, liveTick = 0): string[] {
  const indicator = message.status === "running"
    ? spinnerFrame(liveTick)
    : message.status === "success"
      ? "◇"
      : message.status === "failure"
        ? "\u00D7"
        : message.status === "rejected"
          ? "!"
          : "-";
  const label = toolDisplayName(message.name);
  const argument = toolArgumentSummary(message);
  const call = argument
    ? `${ANSI.toolBold}${label}${ANSI.reset} ${ANSI.gray}${argument}${ANSI.reset}`
    : `${ANSI.toolBold}${label}${ANSI.reset}`;
  const duration = message.durationMs === undefined
    ? ""
    : `  ${ANSI.gray}${formatDuration(message.durationMs)}${ANSI.reset}`;
  const status = message.status === "running" || message.status === "success"
    ? ""
    : `  ${message.status === "failure" || message.status === "rejected" ? ANSI.redBold : ANSI.amberBold}${message.status}${ANSI.reset}`;
  const indicatorColor = message.status === "failure" || message.status === "rejected"
    ? ANSI.redBold
    : message.status === "success"
      ? ANSI.greenBold
      : ANSI.orangeBold;
  const detail = message.summary || message.error || "";
  const summary = detail && (message.status !== "success" || shouldShowSuccessSummary(detail))
    ? ` ${ANSI.gray}\u00b7 ${truncateVisible(detail.replace(/\s+/g, " ").trim(), 80)}${ANSI.reset}`
    : "";
  const heading = `${indicatorColor}${indicator}${ANSI.reset} ${call}${status}${duration}${summary}`;
  const lines = wrapDisplayText(heading, width);
  const output = message.error || message.output || "";
  if (message.expanded && output) {
    const preview = output.split(/\r?\n/).filter(Boolean);
    const limit = 12;
    lines.push(...preview.slice(0, limit).flatMap((line) => wrapDisplayText(`  \u2502 ${line}`, width)));
    if (preview.length > limit) lines.push(`${ANSI.gray}  \u2502 ... ${preview.length - limit} more lines (Ctrl+O to expand)${ANSI.reset}`);
  } else if (output && message.status !== "success" && output.trim() !== detail.trim()) {
    const error = truncateVisible(output.replace(/\s+/g, " ").trim(), Math.max(40, width * 2));
    lines.push(...wrapDisplayText(`  \u2502 ${error}`, width).slice(0, 2));
  }
  if (message.expanded && (message.name === "apply_patch" || message.name === "write_file")) {
    const contentValue = typeof message.arguments.content === "string" ? message.arguments.content : "";
    if (contentValue) lines.push(...renderDiff(contentValue, width, true));
  }
  return lines;
}

function toolDisplayName(name: string): string {
  switch (name) {
    case "read_file": return "Read";
    case "write_file": return "Write";
    case "edit_file": return "Edit";
    case "apply_patch": return "Write";
    case "run_command": return "Bash";
    case "glob_files": return "Glob";
    case "search_code": return "Search";
    case "list_files": return "List";
    case "git_status": return "GitStatus";
    case "get_diff": return "Diff";
    default: return name;
  }
}

function toolArgumentSummary(message: ToolMessage): string {
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

function integerArgument(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function shouldShowSuccessSummary(detail: string): boolean {
  const text = detail.trim();
  if (!text) return false;
  return text !== "ok";
}

function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(value))}ms`;
}
