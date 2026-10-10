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
  // 已完成调用显示总耗时;运行中的显示已用时间(long tool 卡哪步一眼可见)。
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
  const detail = message.summary || message.error || "";
  const summary =
    detail && (message.status !== "success" || shouldShowSuccessSummary(detail))
      ? ` ${ANSI.gray}\u00b7 ${truncateVisible(detail.replace(/\s+/g, " ").trim(), 80)}${ANSI.reset}`
      : "";
  const headingPrefix = `${indicatorColor}${indicator}${ANSI.reset} `;
  const headingBody = `${call}${status}${duration}${summary}${badges}`;
  const headingWidth = Math.max(1, width - visibleWidth(headingPrefix));
  const lines = wrapDisplayText(headingBody, headingWidth).map(
    (line, index) => `${index === 0 ? headingPrefix : " ".repeat(2)}${line}`,
  );
  const output = message.error || message.output || "";
  const changeDiff = writeToolDiff(message);
  if (message.expanded && output && !changeDiff) {
    // 只显示前 12 行会丢掉长输出真正值钱的部分(失败栈、汇总行几乎总在尾部),
    // 所以改为"头部 8 行 + 省略提示 + 尾部 4 行",头尾可见、细节再 ctrl+t 看。
    const preview = output.split(/\r?\n/).filter(Boolean);
    const HEAD = 8;
    const TAIL = 4;
    const shown = preview.length <= HEAD + TAIL ? preview : [...preview.slice(0, HEAD), undefined, ...preview.slice(-TAIL)];
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
  // File-modifying tools always surface what changed (diff-style), collapsed
  // to a short preview; ctrl+t on the row expands it to more lines.
  if (changeDiff) lines.push(...renderDiff(changeDiff, width, message.expanded));
  return lines;
}

/** Synthetic unified-diff text for file-modifying tools, or undefined for read-only tools. */
function writeToolDiff(message: ToolMessage): string | undefined {
  // Failed, rejected, cancelled, and running calls did not produce a confirmed
  // file change, so do not present their requested arguments as an applied diff.
  if (message.status !== "success") return undefined;
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
