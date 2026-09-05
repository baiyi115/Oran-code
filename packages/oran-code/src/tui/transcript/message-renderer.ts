import type { TranscriptMessage, VerificationMessage } from "../types.js";
import { formatDuration } from "../../formatting.js";
import { renderMarkdown, type MarkdownRenderer } from "./markdown-renderer.js";
import { renderToolMessage } from "./tool-message.js";
import { stripTerminalMarkup, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";
import { spinnerFrame } from "../status-indicator.js";

export interface MessageRenderContext {
  markdownRenderer?: MarkdownRenderer;
  liveTick?: number;
  /** Render finished thoughts with their full body (used by expanded thought-segments). */
  forceExpandThoughts?: boolean;
}

export function renderMessage(message: TranscriptMessage, width: number, context: MessageRenderContext = {}): string[] {
  if (message.kind === "tool") return withMessageSpacing(renderToolMessage(message, width, context.liveTick));
  if (message.kind === "verification") return withMessageSpacing(renderVerification(message, width));
  if (message.kind === "thought")
    return withMessageSpacing(renderThought(message, width, context.liveTick, context.forceExpandThoughts === true));
  if (message.kind === "error") return withMessageSpacing(renderError(message.text, width));
  if (message.kind === "assistant" && !message.text.trim() && !message.streaming) return [];

  const prefix = prefixFor(message.kind);
  const prefixWidth = prefixVisibleWidth(message.kind);
  let text = message.kind === "user" && message.queued ? `[Queued] ${message.text}` : message.text;
  // An aborted turn appends "[reason]" to the assistant text. Keep that line
  // out of the Markdown pass so cancellation reasons with markdown characters
  // render as plain text instead of being parsed as syntax.
  let abortMarker: string | undefined;
  if (message.kind === "assistant" && message.abortMessage) {
    const marker = `[${message.abortMessage}]`;
    if (text.endsWith(marker)) {
      text = text.slice(0, text.length - marker.length).replace(/\n+$/, "");
      abortMarker = marker;
    }
  }
  const markdownOptions = { streaming: message.kind === "assistant" && Boolean(message.streaming) };
  const content =
    message.kind === "assistant" || message.kind === "plan"
      ? context.markdownRenderer
        ? context.markdownRenderer.render(text, Math.max(1, width - prefixWidth), markdownOptions)
        : renderMarkdown(text, Math.max(1, width - prefixWidth), markdownOptions)
      : wrapDisplayText(stripTerminalMarkup(text).trimEnd(), Math.max(1, width - prefixWidth));

  const contentEmpty = !content.length;
  let lines: string[];
  if (contentEmpty) lines = [prefix.trimEnd()];
  else lines = content.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);

  if (abortMarker) {
    const indent = " ".repeat(prefixWidth);
    for (const line of wrapDisplayText(abortMarker, Math.max(1, width - prefixWidth))) {
      lines.push(`${indent}${ANSI.yellow}${line}${ANSI.reset}`);
    }
  }

  return withMessageSpacing(lines);
}

function withMessageSpacing(lines: string[]): string[] {
  if (!lines.length) return lines;
  // Trailing blank line keeps turns from packing against the next block/composer.
  if (lines[lines.length - 1] === "") return lines;
  return [...lines, ""];
}

function prefixFor(kind: TranscriptMessage["kind"]): string {
  switch (kind) {
    case "user":
      return `${ANSI.orangeBold}>${ANSI.reset} `;
    case "assistant":
      return "  ";
    case "thought":
      return "+ ";
    case "plan":
      return `${ANSI.amberBold}Plan${ANSI.reset}  `;
    case "tool":
      return "tool  ";
    case "verification":
      return "check ";
    case "error":
      return `${ANSI.redBold}Error${ANSI.reset} `;
    case "system":
      return "      ";
  }
}

function prefixVisibleWidth(kind: TranscriptMessage["kind"]): number {
  switch (kind) {
    case "assistant":
    case "user":
      return 2;
    case "error":
      return 6;
    case "plan":
      return 6;
    default:
      // eslint-disable-next-line no-control-regex -- 控制字符是刻意匹配的目标（ANSI 转义/文本清洗）
      return prefixFor(kind).replace(/\u001b\[[0-9;]*m/g, "").length;
  }
}

function renderError(text: string, width: number): string[] {
  const prefix = prefixFor("error");
  const prefixWidth = prefixVisibleWidth("error");
  const contentWidth = Math.max(1, width - prefixWidth);
  const sections = stripTerminalMarkup(text).trimEnd().split(/\r?\n/);
  const primary = wrapDisplayText(sections.shift() ?? "", contentWidth);
  if (!primary.length) return [prefix.trimEnd()];
  const indent = " ".repeat(prefixWidth);
  const details = wrapDisplayText(sections.join("\n"), contentWidth).map(
    (line) => `${indent}${ANSI.gray}${line}${ANSI.reset}`,
  );
  return primary.map((line, index) => `${index === 0 ? prefix : indent}${line}`).concat(details);
}

function renderThought(
  message: Extract<TranscriptMessage, { kind: "thought" }>,
  width: number,
  liveTick = 0,
  forceExpand = false,
): string[] {
  const body = stripTerminalMarkup(message.text).trim();
  // No body and not actively streaming => hide. Models without reasoning never show a row.
  if (!body && !message.streaming) return [];

  const label = thoughtLabel(message);
  const contentWidth = Math.max(1, width - 2);

  if (message.streaming) {
    const lines = [styleThoughtLabel(`${spinnerFrame(liveTick)} ${label}`)];
    if (body) {
      // Live preview stays short so the answer stream remains the focus.
      for (const line of thoughtPreviewLines(body, contentWidth, 3)) {
        lines.push(styleThought(`  ${line}`));
      }
    }
    return lines;
  }

  if (message.expanded || forceExpand) {
    const lines = [styleThoughtLabel(`◆ ${label}`)];
    lines.push(...wrapDisplayText(body, contentWidth).map((line) => styleThought(`  ${line}`)));
    return lines;
  }

  // Collapsed finished thoughts collapse to a single line; Ctrl+T expands the full text.
  return [`${styleThoughtLabel(label)}${ANSI.gray}  (ctrl+t to expand)${ANSI.reset}`];
}

function thoughtLabel(message: Extract<TranscriptMessage, { kind: "thought" }>): string {
  if (message.streaming) return "Thinking...";
  if (message.durationMs !== undefined) return `Thought for ${formatDuration(message.durationMs)}`;
  return "Thought";
}

function thoughtPreviewLines(body: string, width: number, maxLines: number): string[] {
  const wrapped = wrapDisplayText(body, width);
  if (wrapped.length <= maxLines) return wrapped;
  return [...wrapped.slice(0, maxLines - 1), "…"];
}

function styleThought(value: string): string {
  return `${ANSI.gray}${ANSI.italic}${value}\u001b[23m${ANSI.reset}`;
}

function styleThoughtLabel(value: string): string {
  return `${ANSI.amberBold}${value}${ANSI.reset}`;
}

function renderVerification(message: VerificationMessage, width: number): string[] {
  const lines = [`${ANSI.toolBold}Check${ANSI.reset}`];
  for (const result of message.results) {
    const status = result.passed ? "passed" : "failed";
    const statusColor = result.passed ? ANSI.greenBold : ANSI.redBold;
    lines.push(
      ...wrapDisplayText(
        `  ${ANSI.tool}${result.command}${ANSI.reset} ${statusColor}${status}${ANSI.reset}${ANSI.gray} · ${formatDuration(result.durationMs)}${ANSI.reset}`,
        width,
      ),
    );
    if (result.output.trim()) {
      lines.push(
        ...wrapDisplayText(`  ${ANSI.gray}│ ${result.output.trim().split(/\r?\n/)[0] ?? ""}${ANSI.reset}`, width),
      );
    }
  }
  return lines;
}

