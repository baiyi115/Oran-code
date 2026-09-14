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

  const lines: string[] = [
    `${headerTag}${stepLabel}`,
    dimHorizontalRule(safeWidth),
    current.question,
    "",
  ];

  if (isMulti) {
    lines.push("  (Press Space to toggle, Enter to confirm)", "");
  }

  // Render options
  current.options.forEach((opt, idx) => {
    const isFocused = idx === selectedIndex;
    const isChecked = isMulti ? selectedIndices.includes(idx) : isFocused;

    let marker = "";
    if (isMulti) {
      marker = isChecked ? "[✓]" : "[ ]";
    } else {
      marker = isFocused ? "●" : "○";
    }

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
    const previewRawLines = activeOption.preview.split("\n");
    const previewDisplay = previewRawLines.slice(0, 8); // cap preview to 8 lines
    for (const pLine of previewDisplay) {
      lines.push(`  │ ${truncateVisible(pLine, safeWidth - 6)}`);
    }
    if (previewRawLines.length > 8) {
      lines.push(`  │ ... (${previewRawLines.length - 8} more lines)`);
    }
  }

  lines.push(
    "",
    isMulti
      ? "↑↓ Navigate   Space Toggle   Enter Confirm   Esc Reject"
      : "↑↓ Navigate   Enter Confirm   Esc Reject",
  );

  return lines.flatMap((line) => {
    if (!line) return [""];
    return visibleWidth(line) <= safeWidth ? [line] : wrapDisplayText(line, safeWidth);
  });
}
