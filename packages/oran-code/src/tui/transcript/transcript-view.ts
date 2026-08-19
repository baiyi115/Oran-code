import type { TuiState, TranscriptMessage } from "../types.js";
import { MarkdownRenderer } from "./markdown-renderer.js";
import { renderMessage } from "./message-renderer.js";
import { wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";

export interface TranscriptRenderLine {
  text: string;
  messageId: string;
  lineOffset: number;
}

export class TranscriptView {
  private readonly cache = new Map<string, {
    width: number;
    signature: string;
    text: string | undefined;
    lines: string[];
    markdownRenderer: MarkdownRenderer;
  }>();

  render(messages: readonly TranscriptMessage[], width: number): string[] {
    const safeWidth = Math.max(12, width);
    const activeIds = new Set(messages.map((message) => message.id));
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }
    return this.renderItems(messages, safeWidth, 0, new Set()).map((line) => line.text);
  }

  lines(state: TuiState, width: number): string[] {
    const safeWidth = Math.max(12, width);
    this.pruneCache(state.transcript);
    return this.renderItems(state.transcript, safeWidth, 0, state.expandedToolGroupIds).map((line) => line.text);
  }

  renderLines(
    messages: readonly TranscriptMessage[],
    width: number,
    liveTick = 0,
    expandedToolGroupIds: ReadonlySet<string> = new Set(),
  ): TranscriptRenderLine[] {
    const safeWidth = Math.max(12, width);
    this.pruneCache(messages);
    return this.renderItems(messages, safeWidth, liveTick, expandedToolGroupIds);
  }

  linesWithAnchors(state: TuiState, width: number, liveTick = 0): TranscriptRenderLine[] {
    return this.renderLines(state.transcript, width, liveTick, state.expandedToolGroupIds);
  }

  private pruneCache(messages: readonly TranscriptMessage[]): void {
    const activeIds = new Set(messages.map((message) => message.id));
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }
  }

  private renderItems(
    messages: readonly TranscriptMessage[],
    width: number,
    liveTick: number,
    expandedToolGroupIds: ReadonlySet<string>,
  ): TranscriptRenderLine[] {
    return transcriptRenderItems(messages, expandedToolGroupIds).flatMap((item) => {
      if (item.kind === "segment") {
        return renderCollapsedSegment(item.segment, width).map((text, lineOffset) => ({
          text,
          messageId: item.segment.messages[0]!.id,
          lineOffset,
        }));
      }
      return this.renderMessage(item.message, width, liveTick, item.expandThoughts === true).map((text, lineOffset) => ({
        text,
        messageId: item.message.id,
        lineOffset,
      }));
    });
  }

  private renderMessage(message: TranscriptMessage, width: number, liveTick = 0, forceThoughtExpanded = false): string[] {
    const signature = `${messageSignature(message)}:${liveSignature(message, liveTick)}:${forceThoughtExpanded ? 1 : 0}`;
    const text = messageText(message);
    const cached = this.cache.get(message.id);
    if (cached && cached.width === width && cached.signature === signature && cached.text === text) return cached.lines;

    const markdownRenderer = cached?.markdownRenderer ?? new MarkdownRenderer();
    const lines = renderMessage(message, width, { markdownRenderer, liveTick, forceExpandThoughts: forceThoughtExpanded });
    this.cache.set(message.id, { width, signature, text, lines, markdownRenderer });
    return lines;
  }
}

/** File-mutating and command-executing tools always render individually so actions stay visible. */
const NON_COLLAPSIBLE_TOOL_NAMES = new Set(["write_file", "edit_file", "apply_patch", "apply_diff", "run_command"]);
/** A thought+tool run collapses only when it contains at least this many tools. */
const SEGMENT_MIN_TOOLS = 2;

type TranscriptRenderItem =
  | { kind: "message"; message: TranscriptMessage; expandThoughts?: boolean }
  | { kind: "segment"; segment: TranscriptSegment };

/** A collapsible unit: a consecutive run of finished thoughts + successful read-only tools. */
export interface TranscriptSegment {
  id: string;
  messages: TranscriptMessage[];
  thoughtCount: number;
  toolCount: number;
  thoughtDurationMs: number;
}

function buildSegment(messages: readonly TranscriptMessage[]): TranscriptSegment {
  let thoughtCount = 0;
  let toolCount = 0;
  let thoughtDurationMs = 0;
  for (const message of messages) {
    if (message.kind === "thought") {
      thoughtCount += 1;
      thoughtDurationMs += message.durationMs ?? 0;
    } else if (message.kind === "tool") {
      toolCount += 1;
    }
  }
  return {
    // The first message is stable while more tools append to the same batch,
    // so an expanded batch does not collapse again mid-run when its tail grows.
    id: `segment:${messages[0]?.id ?? ""}`,
    messages: [...messages],
    thoughtCount,
    toolCount,
    thoughtDurationMs,
  };
}

function isSegmentThought(message: TranscriptMessage): boolean {
  return message.kind === "thought" && !message.streaming;
}

function isSegmentTool(message: TranscriptMessage): boolean {
  return message.kind === "tool" && message.status === "success" && !NON_COLLAPSIBLE_TOOL_NAMES.has(message.name);
}

function isSegmentMember(message: TranscriptMessage): boolean {
  return isSegmentThought(message) || isSegmentTool(message);
}

/**
 * Split a consecutive member-run into thought-driven batches: a thought that
 * arrives after tools closes the current batch, so each "thought -> its tool
 * calls" rhythm becomes its own collapsible segment. Consecutive thoughts
 * before any tool accumulate into a single "Thoughts for Xs" label.
 */
function splitRunIntoSegments(run: readonly TranscriptMessage[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptMessage[] = [];
  let currentHasTool = false;
  const flush = (): void => {
    if (current.length) segments.push(buildSegment(current));
    current = [];
    currentHasTool = false;
  };
  for (const message of run) {
    if (message.kind === "thought") {
      if (currentHasTool) flush();
      current.push(message);
    } else {
      current.push(message);
      currentHasTool = true;
    }
  }
  flush();
  return segments;
}

/** All transcript batches that currently qualify for compact rendering. */
export function collapsibleSegments(messages: readonly TranscriptMessage[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let run: TranscriptMessage[] = [];
  const flushRun = (): void => {
    if (run.length) {
      segments.push(...splitRunIntoSegments(run).filter((segment) => segment.toolCount >= SEGMENT_MIN_TOOLS));
    }
    run = [];
  };
  for (const message of messages) {
    if (isSegmentMember(message)) run.push(message);
    else flushRun();
  }
  flushRun();
  return segments;
}

function transcriptRenderItems(
  messages: readonly TranscriptMessage[],
  expandedToolGroupIds: ReadonlySet<string>,
): TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isSegmentMember(message)) {
      items.push({ kind: "message", message });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < messages.length && isSegmentMember(messages[end]!)) end += 1;
    for (const segment of splitRunIntoSegments(messages.slice(index, end))) {
      if (segment.toolCount >= SEGMENT_MIN_TOOLS && !expandedToolGroupIds.has(segment.id)) {
        items.push({ kind: "segment", segment });
      } else {
        // Expanded (or too small to collapse): show the original interleaved
        // rendering; thoughts inside an expanded segment open fully.
        const expandThoughts = segment.toolCount >= SEGMENT_MIN_TOOLS;
        items.push(...segment.messages.map((entry) => ({ kind: "message" as const, message: entry, expandThoughts })));
      }
    }
    index = end;
  }
  return items;
}

function renderCollapsedSegment(segment: TranscriptSegment, width: number): string[] {
  const lines: string[] = [];
  if (segment.thoughtCount > 0) {
    const label = segment.thoughtCount === 1 ? "Thought" : "Thoughts";
    const thought = segment.thoughtDurationMs > 0
      ? `${label} for ${formatSegmentDuration(segment.thoughtDurationMs)}`
      : label;
    lines.push(...wrapDisplayText(`${ANSI.amberBold}${thought}${ANSI.reset}`, width));
  }
  const tools = `${segment.toolCount} tool${segment.toolCount === 1 ? "" : "s"}`;
  lines.push(...wrapDisplayText(
    `${ANSI.greenBold}◇${ANSI.reset} ${ANSI.toolBold}${tools}${ANSI.reset} ${ANSI.gray}· ctrl+t to expand${ANSI.reset}`,
    width,
  ));
  return [...lines, ""];
}

function formatSegmentDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(value))}ms`;
}

function liveSignature(message: TranscriptMessage, liveTick: number): number {
  if (message.kind === "assistant" && message.streaming) return liveTick;
  if (message.kind === "thought" && message.streaming) return liveTick;
  if (message.kind === "tool" && message.status === "running") return liveTick;
  return 0;
}

export function transcriptLines(entries: readonly TranscriptMessage[], width: number): string[] {
  return new TranscriptView().render(entries, width);
}

function messageSignature(message: TranscriptMessage): string {
  switch (message.kind) {
    case "user":
      return `user:${message.queued ? 1 : 0}`;
    case "assistant":
      return `assistant:${message.streaming ? 1 : 0}`;
    case "thought":
      return `thought:${message.streaming ? 1 : 0}:${message.expanded ? 1 : 0}:${message.durationMs ?? ""}`;
    case "tool":
      return [
        "tool",
        message.status,
        message.expanded ? "1" : "0",
        message.durationMs ?? "",
        message.summary ?? "",
        message.output ?? "",
        message.error ?? "",
      ].join(":");
    case "verification":
      return `verification:${JSON.stringify(message.results)}`;
    default:
      return message.kind;
  }
}

function messageText(message: TranscriptMessage): string | undefined {
  switch (message.kind) {
    case "user":
    case "assistant":
    case "thought":
    case "plan":
    case "error":
    case "system":
      return message.text;
    default:
      return undefined;
  }
}
