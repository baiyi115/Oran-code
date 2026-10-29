import { visibleWidth, wrapDisplayText } from "../text-width.js";

export interface VisibleSelection {
  readonly start: number;
  readonly end: number;
}

/**
 * One rendered overlay row. The selection is a flag rather than a marker inside the text: markers
 * let user content be parsed as formatting, let the strip regex eat literal `{word}` text, and
 * vanished whenever a selected row had to be wrapped.
 */
export interface OverlayLine {
  readonly text: string;
  readonly selected?: boolean;
}

export function visibleSelection(index: number, length: number, height: number): VisibleSelection {
  const safeLength = Math.max(0, Math.floor(length));
  const safeHeight = Math.max(1, Math.floor(height));
  if (safeLength <= safeHeight) return { start: 0, end: safeLength };
  const selected = Math.max(0, Math.min(safeLength - 1, Math.floor(index)));
  const start = Math.max(0, Math.min(selected - safeHeight + 1, safeLength - safeHeight));
  return { start, end: start + safeHeight };
}

export function overlayLine(text: string): OverlayLine {
  return { text };
}

export function highlightSelection(value: string, selected: boolean): OverlayLine {
  return selected ? { text: value, selected: true } : { text: value };
}

/** Wrap one row to the overlay width, carrying the selection flag onto every row it produces. */
export function wrapOverlayLine(line: OverlayLine, width: number): OverlayLine[] {
  const rows = visibleWidth(line.text) <= width ? [line.text] : wrapDisplayText(line.text, width);
  return rows.map((text) => (line.selected === true ? { text, selected: true } : { text }));
}
