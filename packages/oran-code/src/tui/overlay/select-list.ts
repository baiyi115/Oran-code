export interface VisibleSelection {
  readonly start: number;
  readonly end: number;
}

export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function visibleSelection(index: number, length: number, height: number): VisibleSelection {
  const safeLength = Math.max(0, Math.floor(length));
  const safeHeight = Math.max(1, Math.floor(height));
  if (safeLength <= safeHeight) return { start: 0, end: safeLength };
  const selected = Math.max(0, Math.min(safeLength - 1, Math.floor(index)));
  const start = Math.max(0, Math.min(selected - safeHeight + 1, safeLength - safeHeight));
  return { start, end: start + safeHeight };
}

export function highlightSelection(value: string, selected: boolean): string {
  return selected ? `{inverse}${value}{/inverse}` : value;
}
