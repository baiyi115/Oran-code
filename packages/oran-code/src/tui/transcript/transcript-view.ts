import type { TuiState, TranscriptMessage } from "../types.js";
import { MarkdownRenderer } from "./markdown-renderer.js";
import { renderMessage } from "./message-renderer.js";

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
    return messages.flatMap((message) => this.renderMessage(message, safeWidth));
  }

  lines(state: TuiState, width: number): string[] {
    return this.render(state.transcript, width);
  }

  renderLines(messages: readonly TranscriptMessage[], width: number, liveTick = 0): TranscriptRenderLine[] {
    const safeWidth = Math.max(12, width);
    const activeIds = new Set(messages.map((message) => message.id));
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }
    return messages.flatMap((message) => this.renderMessage(message, safeWidth, liveTick).map((text, lineOffset) => ({
      text,
      messageId: message.id,
      lineOffset,
    })));
  }

  linesWithAnchors(state: TuiState, width: number, liveTick = 0): TranscriptRenderLine[] {
    return this.renderLines(state.transcript, width, liveTick);
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

function liveSignature(message: TranscriptMessage, liveTick: number): number {
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
