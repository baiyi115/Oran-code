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
  anchorApplied = Boolean(state.anchor),
): number {
  const maximum = Math.max(0, Math.floor(contentLines) - Math.max(1, Math.floor(viewportLines)));
  if (!state.followBottom && !anchorApplied && contentLines > previousContentLines) {
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

/**
 * Whether this frame takes the wheel from the host terminal.
 *
 * The app can only scroll what it renders: the details overlay, and the live region — the part of
 * the transcript not yet committed to Ink Static. Older output has already been printed above the
 * frame and lives in the terminal's own scrollback, which mouse reporting takes out of the
 * terminal's hands. Holding the wheel while the live region fits the frame is the worst of both:
 * the terminal stops scrolling, and the app has nothing of its own to move.
 */
export function shouldCaptureWheel(options: {
  readonly overlayOpen: boolean;
  readonly detailsOpen: boolean;
  readonly liveLines: number;
  readonly viewportLines: number;
  readonly offsetFromBottom: number;
}): boolean {
  if (options.detailsOpen) return true;
  // Any other overlay hides the transcript, so the wheel has nothing here to move either.
  if (options.overlayOpen) return false;
  return options.liveLines > Math.max(1, Math.floor(options.viewportLines)) || options.offsetFromBottom > 0;
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
