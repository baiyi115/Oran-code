import type { TuiState, TranscriptMessage } from "../types.js";
import { MarkdownRenderer } from "./markdown-renderer.js";
import { renderMessage } from "./message-renderer.js";
import { wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";
import { formatDuration } from "../../formatting.js";
import { isLiveMessage } from "./live-message.js";

export interface TranscriptRenderLine {
  text: string;
  messageId: string;
  lineOffset: number;
}

export interface TranscriptRenderOptions {
  /**
   * Render collapsible segments message by message instead of as one "◇ N tools" row. The details
   * overlay needs the bodies; the transcript itself never does, because a committed row cannot be
   * re-rendered once Static owns it.
   */
  readonly expandSegments?: boolean;
}

export class TranscriptView {
  private readonly cache = new Map<
    string,
    {
      width: number;
      signature: string;
      text: string | undefined;
      lines: string[];
      markdownRenderer: MarkdownRenderer;
    }
  >();
  /**
   * Collapsed segments are pure functions of their counts and the width, so their rows are cached
   * too: a long session holds many of them and re-wrapping every row per frame is measurable.
   */
  private readonly segmentCache = new Map<string, { signature: string; lines: string[] }>();

  renderLines(
    messages: readonly TranscriptMessage[],
    width: number,
    liveTick = 0,
    options: TranscriptRenderOptions = {},
  ): TranscriptRenderLine[] {
    const safeWidth = Math.max(12, width);
    this.pruneCache(messages);
    return this.renderItems(messages, safeWidth, liveTick, options.expandSegments === true);
  }

  linesWithAnchors(
    state: TuiState,
    width: number,
    liveTick = 0,
    options: TranscriptRenderOptions = {},
  ): TranscriptRenderLine[] {
    return this.renderLines(state.transcript, width, liveTick, options);
  }

  private pruneCache(messages: readonly TranscriptMessage[]): void {
    const activeIds = new Set(messages.map((message) => message.id));
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }
    // A segment id is `segment:<first message id>`, so the first message still being present is
    // enough to keep its cached rows.
    for (const id of this.segmentCache.keys()) {
      if (!activeIds.has(id.slice(SEGMENT_ID_PREFIX.length))) this.segmentCache.delete(id);
    }
  }

  private renderItems(
    messages: readonly TranscriptMessage[],
    width: number,
    liveTick: number,
    expandSegments: boolean,
  ): TranscriptRenderLine[] {
    return transcriptRenderItems(messages, expandSegments).flatMap((item) => {
      if (item.kind === "segment") {
        const segment = item.segment;
        return this.renderSegment(segment, width).map((text, lineOffset) => ({
          text,
          messageId: segment.messages[0]!.id,
          lineOffset,
        }));
      }
      return this.renderMessage(item.message, width, liveTick, item.expandThoughts === true).map(
        (text, lineOffset) => ({
          text,
          messageId: item.message.id,
          lineOffset,
        }),
      );
    });
  }

  private renderSegment(segment: TranscriptSegment, width: number): string[] {
    const signature = `${width}:${segment.thoughtCount}:${segment.toolCount}:${segment.thoughtDurationMs}:${segment.messages
      .filter((message) => message.kind === "tool")
      .map((message) => message.name)
      .join(",")}`;
    const cached = this.segmentCache.get(segment.id);
    if (cached?.signature === signature) return cached.lines;
    const lines = renderCollapsedSegment(segment, width);
    this.segmentCache.set(segment.id, { signature, lines });
    return lines;
  }

  private renderMessage(
    message: TranscriptMessage,
    width: number,
    liveTick = 0,
    forceThoughtExpanded = false,
  ): string[] {
    const signature = `${messageSignature(message)}:${liveSignature(message, liveTick)}:${forceThoughtExpanded ? 1 : 0}`;
    const text = messageText(message);
    const cached = this.cache.get(message.id);
    if (cached && cached.width === width && cached.signature === signature && cached.text === text) return cached.lines;

    const markdownRenderer = cached?.markdownRenderer ?? new MarkdownRenderer();
    const lines = renderMessage(message, width, {
      markdownRenderer,
      liveTick,
      forceExpandThoughts: forceThoughtExpanded,
    });
    this.cache.set(message.id, { width, signature, text, lines, markdownRenderer });
    return lines;
  }
}

/** Only known exploration tools collapse; commands, edits and extension actions stay visible. */
const COLLAPSIBLE_TOOL_NAMES = new Set([
  "read_file",
  "search_code",
  "glob_files",
  "list_files",
  "show_signature",
  "git_status",
  "get_diff",
]);
/** A thought+tool run collapses only when it contains at least this many tools. */
const SEGMENT_MIN_TOOLS = 2;
/** Segment ids are derived from the first message id; the cache prunes by that id. */
const SEGMENT_ID_PREFIX = "segment:";

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
    id: `${SEGMENT_ID_PREFIX}${messages[0]?.id ?? ""}`,
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
  return message.kind === "tool" && message.status === "success" && COLLAPSIBLE_TOOL_NAMES.has(message.name);
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

/**
 * Index where the transcript's trailing collapsible segment starts, or `messages.length` when the
 * tail does not collapse. A segment renders under its first message id and Ink Static never
 * re-renders a committed item, so a segment that can still gain members (the next read-only tool of
 * the same batch finishing) must stay in the live frame; committing it earlier would freeze its
 * "◇ N tools" row at the old count and the later rows would never appear anywhere.
 */
export function trailingSegmentStart(messages: readonly TranscriptMessage[]): number {
  let runStart = messages.length;
  while (runStart > 0 && isSegmentMember(messages[runStart - 1]!)) runStart -= 1;
  if (runStart === messages.length) return messages.length;
  const trailing = splitRunIntoSegments(messages.slice(runStart)).at(-1);
  // Below the collapse threshold the run renders per message, so those ids commit on their own.
  if (!trailing || trailing.toolCount < SEGMENT_MIN_TOOLS) return messages.length;
  return messages.length - trailing.messages.length;
}

function transcriptRenderItems(
  messages: readonly TranscriptMessage[],
  expandSegments: boolean,
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
      if (segment.toolCount >= SEGMENT_MIN_TOOLS && !expandSegments) {
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
  const counts = new Map<string, number>();
  for (const message of segment.messages) {
    if (message.kind === "tool") counts.set(message.name, (counts.get(message.name) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (segment.thoughtCount > 0) {
    parts.push(segment.thoughtDurationMs > 0 ? `Thought for ${formatDuration(segment.thoughtDurationMs)}` : "Thought");
  }
  const activities: Array<[string, string, string]> = [
    ["read_file", "read", "file"],
    ["search_code", "searched for", "pattern"],
    ["glob_files", "matched", "file pattern"],
    ["list_files", "listed", "directory"],
    ["show_signature", "inspected", "outline"],
    ["git_status", "checked", "git status"],
    ["get_diff", "viewed", "diff"],
  ];
  for (const [name, verb, noun] of activities) {
    const count = counts.get(name) ?? 0;
    if (!count) continue;
    const plural = noun === "directory" ? "directories" : noun === "git status" ? "git statuses" : `${noun}s`;
    parts.push(`${verb} ${count} ${count === 1 ? noun : plural}`);
  }
  const text = `${parts.join(", ")} (ctrl+o details)`;
  return [...wrapDisplayText(text, Math.max(1, width - 2)).map((line) => `  ${ANSI.gray}${line}${ANSI.reset}`), ""];
}

function liveSignature(message: TranscriptMessage, liveTick: number): number {
  // Only rows that draw a spinner depend on the tick; an assistant row is pure text, so tying it to
  // the tick would force a full markdown re-render on every spinner frame for no visible change.
  return isLiveMessage(message) && message.kind !== "assistant" ? liveTick : 0;
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
      // Concatenating the full output into the signature would copy huge strings on every repaint
      // (120ms); status/summary plus the length cover all real changes (they always accompany a
      // state transition). The diff arrives with the result, so its length and counts join them.
      return [
        "tool",
        message.status,
        message.expanded ? "1" : "0",
        message.durationMs ?? "",
        message.summary ?? "",
        message.output?.length ?? 0,
        message.error?.length ?? 0,
        message.diff ? `${message.diff.text.length}:${message.diff.added}:${message.diff.removed}` : "",
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
