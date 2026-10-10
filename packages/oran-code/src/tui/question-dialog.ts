import { highlightSelection } from "./overlay/select-list.js";
import { truncateVisible, visibleWidth, wrapDisplayText } from "./text-width.js";
import { dimHorizontalRule } from "./theme.js";
import type { QuestionDialogItem } from "./types.js";

export function questionDialogLines(
  questions: readonly QuestionDialogItem[],
  currentQuestionIndex: number,
  selectedIndex: number,
  selectedIndices: readonly number[],
  width = 80,
): string[] {
  const current = questions[currentQuestionIndex];
  if (!current) return ["No question available"];

  const safeWidth = Math.max(20, width);
  const isMulti = Boolean(current.multiSelect);
  const stepLabel = `Question ${currentQuestionIndex + 1}/${questions.length}`;
  const headerTag = current.header ? `[${current.header.trim()}] ` : "";

  const lines: string[] = [`${headerTag}${stepLabel}`, dimHorizontalRule(safeWidth), current.question, ""];

  if (isMulti) {
    lines.push("  (Press Space to toggle, Enter to confirm)", "");
  }

  // Render options
  current.options.forEach((opt, idx) => {
    const isFocused = idx === selectedIndex;
    const isChecked = isMulti ? selectedIndices.includes(idx) : isFocused;

    const marker = isMulti ? (isChecked ? "[✓]" : "[ ]") : isFocused ? "●" : "○";

    const labelLine = `  ${marker} ${opt.label}`;
    lines.push(highlightSelection(labelLine, isFocused));

    if (opt.description) {
      const descLines = wrapDisplayText(`      ${opt.description}`, safeWidth);
      lines.push(...descLines);
    }
  });

  // Render preview box if focused option has preview content
  const activeOption = current.options[selectedIndex];
  if (activeOption?.preview && activeOption.preview.trim()) {
    lines.push("", "Preview:", dimHorizontalRule(Math.min(safeWidth, 40)));
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
        lines.push(`  │ ... ${previewRawLines.length - HEAD - TAIL} more lines in the middle ...`);
        continue;
      }
      lines.push(`  │ ${truncateVisible(pLine, safeWidth - 6)}`);
    }
  }

  // Esc really means "answer from the first option"; the hint must match the behavior or users
  // will not dare press it.
  lines.push(
    "",
    isMulti
      ? "↑↓ Navigate   Space Toggle   Enter Confirm   Esc Skip remaining"
      : "↑↓ Navigate   Enter Confirm   Esc Skip remaining",
  );

  return lines.flatMap((line) => {
    if (!line) return [""];
    return visibleWidth(line) <= safeWidth ? [line] : wrapDisplayText(line, safeWidth);
  });
}
