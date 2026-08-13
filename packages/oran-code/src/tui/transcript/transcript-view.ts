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
      if (item.kind === "tool-group") {
        return renderCollapsedToolGroup(item.messages, width).map((text, lineOffset) => ({
          text,
          messageId: item.messages[0]!.id,
          lineOffset,
        }));
      }
      return this.renderMessage(item.message, width, liveTick).map((text, lineOffset) => ({
        text,
        messageId: item.message.id,
        lineOffset,
      }));
    });
  }

  private renderMessage(message: TranscriptMessage, width: number, liveTick = 0): string[] {
    const signature = `${messageSignature(message)}:${liveSignature(message, liveTick)}`;
    const text = messageText(message);
    const cached = this.cache.get(message.id);
    if (cached && cached.width === width && cached.signature === signature && cached.text === text) return cached.lines;

    const markdownRenderer = cached?.markdownRenderer ?? new MarkdownRenderer();
    const lines = renderMessage(message, width, { markdownRenderer, liveTick });
    this.cache.set(message.id, { width, signature, text, lines, markdownRenderer });
    return lines;
  }
}

const TOOL_GROUP_MIN_SIZE = 3;

type TranscriptRenderItem =
  | { kind: "message"; message: TranscriptMessage }
  | { kind: "tool-group"; messages: ToolGroup };

export type ToolGroup = readonly Extract<TranscriptMessage, { kind: "tool" }>[];

/** Consecutive successful tools are visually compacted unless explicitly expanded. */
export function toolGroups(messages: readonly TranscriptMessage[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  let run: Extract<TranscriptMessage, { kind: "tool" }>[] = [];
  for (const message of messages) {
    if (message.kind === "tool" && message.status === "success") {
      run.push(message);
      continue;
    }
    if (run.length >= TOOL_GROUP_MIN_SIZE) groups.push(run);
    run = [];
  }
  if (run.length >= TOOL_GROUP_MIN_SIZE) groups.push(run);
  return groups;
}

export function toolGroupId(messages: ToolGroup): string {
  const first = messages[0];
  const last = messages.at(-1);
  return `tool-group:${first?.id ?? ""}:${last?.id ?? ""}`;
}

function transcriptRenderItems(
  messages: readonly TranscriptMessage[],
  expandedToolGroupIds: ReadonlySet<string>,
): TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.kind !== "tool" || message.status !== "success") {
      items.push({ kind: "message", message });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (true) {
      const next = messages[end];
      if (!next || next.kind !== "tool" || next.status !== "success") break;
      end += 1;
    }
    const group = messages.slice(index, end) as ToolGroup;
    if (group.length >= TOOL_GROUP_MIN_SIZE && !expandedToolGroupIds.has(toolGroupId(group))) {
      items.push({ kind: "tool-group", messages: group });
    } else {
      items.push(...group.map((entry) => ({ kind: "message" as const, message: entry })));
    }
    index = end;
  }
  return items;
}

function renderCollapsedToolGroup(messages: ToolGroup, width: number): string[] {
  const count = messages.length;
  const text = `${ANSI.greenBold}◇${ANSI.reset} ${ANSI.toolBold}Called ${count} tools${ANSI.reset} ${ANSI.gray}· Ctrl+O to expand${ANSI.reset}`;
  return [...wrapDisplayText(text, width), ""];
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
