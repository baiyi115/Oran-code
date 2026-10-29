import { highlightSelection, overlayLine, wrapOverlayLine, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible } from "./text-width.js";
import { dimHorizontalRule } from "./theme.js";
import type { QuestionDialogItem } from "./types.js";

export function questionDialogLines(
  questions: readonly QuestionDialogItem[],
  currentQuestionIndex: number,
  selectedIndex: number,
  selectedIndices: readonly number[],
  width = 80,
): OverlayLine[] {
  const current = questions[currentQuestionIndex];
  if (!current) return [overlayLine("No question available")];

  const safeWidth = Math.max(20, width);
  const isMulti = Boolean(current.multiSelect);
  const stepLabel = `Question ${currentQuestionIndex + 1}/${questions.length}`;
  const headerTag = current.header ? `[${current.header.trim()}] ` : "";

  const lines: OverlayLine[] = [
    overlayLine(`${headerTag}${stepLabel}`),
    overlayLine(dimHorizontalRule(safeWidth)),
    overlayLine(current.question),
    overlayLine(""),
  ];

  if (isMulti) {
    lines.push(overlayLine("  (Press Space to toggle, Enter to confirm)"), overlayLine(""));
  }

  // Render options
  current.options.forEach((opt, idx) => {
    const isFocused = idx === selectedIndex;
    const isChecked = isMulti ? selectedIndices.includes(idx) : isFocused;

    const marker = isMulti ? (isChecked ? "[✓]" : "[ ]") : isFocused ? "●" : "○";

    const labelLine = `  ${marker} ${opt.label}`;
    lines.push(highlightSelection(labelLine, isFocused));

    if (opt.description) {
      for (const row of wrapOverlayLine(overlayLine(`      ${opt.description}`), safeWidth)) lines.push(row);
    }
  });

  // Render preview box if focused option has preview content
  const activeOption = current.options[selectedIndex];
  if (activeOption?.preview && activeOption.preview.trim()) {
    lines.push(overlayLine(""), overlayLine("Preview:"), overlayLine(dimHorizontalRule(Math.min(safeWidth, 40))));
    const previewRawLines = activeOption.preview.split("\n").filter((line) => line.trim());
    // Same scheme as tool output: 5 head lines + an omission marker + 3 tail lines; showing only
    // the first 8 lines always drops the real tail of the preview (conclusions sit at the end).
    const HEAD = 5;
    const TAIL = 3;
    const shown =
      previewRawLines.length <= HEAD + TAIL
        ? previewRawLines
        : [...previewRawLines.slice(0, HEAD), undefined, ...previewRawLines.slice(-TAIL)];
    for (const pLine of shown) {
      if (pLine === undefined) {
        lines.push(overlayLine(`  │ ... ${previewRawLines.length - HEAD - TAIL} more lines in the middle ...`));
        continue;
      }
      lines.push(overlayLine(`  │ ${truncateVisible(pLine, safeWidth - 6)}`));
    }
  }

  // Esc dismisses the dialog without answering the rest; the hint must say so, because the answers
  // that do go back are only the ones the user actually chose.
  lines.push(
    overlayLine(""),
    overlayLine(
      isMulti
        ? "↑↓ Navigate   Space Toggle   Enter Confirm   Esc Dismiss"
        : "↑↓ Navigate   Enter Confirm   Esc Dismiss",
    ),
  );

  return lines.flatMap((line) => wrapOverlayLine(line, safeWidth));
}
