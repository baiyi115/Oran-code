import type { TranscriptScrollState } from "./types.js";

export function scrollTranscript(state: TranscriptScrollState, delta: number, maxOffset: number): void {
  const maximum = Math.max(0, Math.floor(maxOffset));
  state.offsetFromBottom = Math.max(0, Math.min(maximum, state.offsetFromBottom + Math.trunc(delta)));
  state.followBottom = state.offsetFromBottom === 0;
}

export function syncTranscriptScroll(
  state: TranscriptScrollState,
  contentLines: number,
  viewportLines: number,
  previousContentLines = contentLines,
): number {
  const maximum = Math.max(0, Math.floor(contentLines) - Math.max(1, Math.floor(viewportLines)));
  if (!state.followBottom && !state.anchor && contentLines > previousContentLines) {
    state.offsetFromBottom += contentLines - previousContentLines;
  }
  state.offsetFromBottom = Math.max(0, Math.min(maximum, state.offsetFromBottom));
  state.followBottom = state.offsetFromBottom === 0;
  return maximum;
}

export function scrollPercent(offsetFromBottom: number, contentLines: number, viewportLines: number): number {
  const maximum = Math.max(0, contentLines - Math.max(1, viewportLines));
  if (!maximum) return 100;
  return Math.max(0, Math.min(100, ((maximum - Math.max(0, offsetFromBottom)) / maximum) * 100));
}

export function transcriptViewportLines(
  lines: readonly string[],
  viewportLines: number,
  offsetFromBottom: number,
): string[] {
  const height = Math.max(1, Math.floor(viewportLines));
  const maximumStart = Math.max(0, lines.length - height);
  const offset = Math.max(0, Math.min(maximumStart, Math.floor(offsetFromBottom)));
  const start = Math.max(0, maximumStart - offset);
  return lines.slice(start, start + height);
}
