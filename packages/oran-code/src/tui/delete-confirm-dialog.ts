import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible } from "./text-width.js";
import { dimHorizontalRule } from "./theme.js";

/**
 * The confirmation shown before a deletion, shared by sessions and providers. The two used to keep
 * their own copies (one inline in render.tsx, one in providers-list.ts) with the same rows in the
 * same order; only the title and the name underneath differ.
 */
export function deleteConfirmLines(
  title: string,
  subject: string,
  selectedIndex: number,
  width: number,
): OverlayLine[] {
  const available = Math.max(1, width);
  return [
    overlayLine(title),
    overlayLine(`  ${truncateVisible(subject, Math.max(1, available - 2))}`),
    overlayLine(dimHorizontalRule(available)),
    overlayLine("←→ Select   Enter Confirm   Esc Cancel"),
    overlayLine(""),
    highlightSelection("  Delete", selectedIndex === 0),
    highlightSelection("  Cancel", selectedIndex === 1),
  ];
}
