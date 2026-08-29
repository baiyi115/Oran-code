import type { ComposerState } from "./types.js";
import {
  graphemeLength,
  graphemeOffset,
  graphemes,
  graphemeWidth,
  sliceByDisplayWidth,
  sliceGraphemes,
  visibleWidth,
} from "./text-width.js";

export interface VisualLine {
  text: string;
  logicalLine: number;
  startColumn: number;
}

export function visualLines(composer: ComposerState, width: number): VisualLine[] {
  const safeWidth = Math.max(1, width);
  const result: VisualLine[] = [];
  composer.lines.forEach((line, logicalLine) => {
    if (!line) {
      result.push({ text: "", logicalLine, startColumn: 0 });
      return;
    }
    let startColumn = 0;
    while (startColumn < graphemeLength(line)) {
      const chunk = sliceByDisplayWidth(line, startColumn, safeWidth);
      result.push({ text: chunk, logicalLine, startColumn });
      startColumn += graphemeLength(chunk) || 1;
    }
  });
  return result.length ? result : [{ text: "", logicalLine: 0, startColumn: 0 }];
}

export function insertText(composer: ComposerState, value: string): void {
  const line = composer.lines[composer.cursor.line] ?? "";
  const symbols = graphemes(line);
  const before = symbols.slice(0, composer.cursor.column).join("");
  const after = symbols.slice(composer.cursor.column).join("");
  const parts = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (parts.length === 1) {
    composer.lines[composer.cursor.line] = before + (parts[0] ?? "") + after;
    composer.cursor.column += graphemeLength(parts[0] ?? "");
    composer.preferredDisplayColumn = undefined;
    return;
  }
  const replacement = [before + (parts[0] ?? ""), ...parts.slice(1, -1), (parts.at(-1) ?? "") + after];
  composer.lines.splice(composer.cursor.line, 1, ...replacement);
  composer.cursor.line += parts.length - 1;
  composer.cursor.column = graphemeLength(parts.at(-1) ?? "");
  composer.preferredDisplayColumn = undefined;
}

export function deleteBackward(composer: ComposerState): void {
  const { line, column } = composer.cursor;
  if (column > 0) {
    const symbols = graphemes(composer.lines[line] ?? "");
    composer.lines[line] = symbols
      .slice(0, column - 1)
      .concat(symbols.slice(column))
      .join("");
    composer.cursor.column -= 1;
  } else if (line > 0) {
    const previous = composer.lines[line - 1] ?? "";
    const current = composer.lines[line] ?? "";
    composer.lines.splice(line - 1, 2, previous + current);
    composer.cursor = { line: line - 1, column: graphemeLength(previous + current) };
  }
  composer.preferredDisplayColumn = undefined;
}

export function deleteForward(composer: ComposerState): void {
  const { line, column } = composer.cursor;
  const current = composer.lines[line] ?? "";
  if (column < graphemeLength(current)) {
    const symbols = graphemes(current);
    composer.lines[line] = symbols
      .slice(0, column)
      .concat(symbols.slice(column + 1))
      .join("");
  } else if (line < composer.lines.length - 1) {
    composer.lines.splice(line, 2, current + (composer.lines[line + 1] ?? ""));
  }
  composer.preferredDisplayColumn = undefined;
}

export function moveCursor(composer: ComposerState, direction: "left" | "right" | "up" | "down", width?: number): void {
  const currentText = composer.lines[composer.cursor.line] ?? "";
  const currentLength = graphemeLength(currentText);
  if (direction === "left") {
    if (composer.cursor.column > 0) composer.cursor.column -= 1;
    else if (composer.cursor.line > 0) {
      composer.cursor.line -= 1;
      composer.cursor.column = graphemeLength(composer.lines[composer.cursor.line] ?? "");
    }
    composer.preferredDisplayColumn = undefined;
    return;
  }
  if (direction === "right") {
    if (composer.cursor.column < currentLength) composer.cursor.column += 1;
    else if (composer.cursor.line < composer.lines.length - 1) {
      composer.cursor.line += 1;
      composer.cursor.column = 0;
    }
    composer.preferredDisplayColumn = undefined;
    return;
  }
  if (width === undefined) {
    const targetLine = direction === "up" ? composer.cursor.line - 1 : composer.cursor.line + 1;
    if (targetLine < 0 || targetLine >= composer.lines.length) return;
    composer.cursor.line = targetLine;
    composer.cursor.column = Math.min(composer.cursor.column, graphemeLength(composer.lines[targetLine] ?? ""));
    composer.preferredDisplayColumn = undefined;
    return;
  }
  const lines = visualLines(composer, width);
  const current = cursorVisualPosition(composer, width);
  const targetRow = direction === "up" ? current.row - 1 : current.row + 1;
  if (targetRow < 0 || targetRow >= lines.length) return;
  const preferred = composer.preferredDisplayColumn ?? current.column;
  const target = lines[targetRow]!;
  const targetText = composer.lines[target.logicalLine] ?? "";
  let column = target.startColumn;
  let display = 0;
  for (const symbol of graphemes(targetText).slice(target.startColumn)) {
    const next = graphemeWidth(symbol);
    if (display + next > preferred) break;
    display += next;
    column += 1;
  }
  composer.cursor = { line: target.logicalLine, column };
  composer.preferredDisplayColumn = preferred;
}

export function moveToLineEdge(composer: ComposerState, edge: "start" | "end"): void {
  const line = composer.lines[composer.cursor.line] ?? "";
  composer.cursor.column = edge === "start" ? 0 : graphemeLength(line);
  composer.preferredDisplayColumn = undefined;
}

export function cursorVisualPosition(composer: ComposerState, width: number): { row: number; column: number } {
  const lines = visualLines(composer, width);
  let target = lines[0]!;
  for (const line of lines) {
    if (line.logicalLine === composer.cursor.line && composer.cursor.column >= line.startColumn) target = line;
  }
  const current = composer.lines[composer.cursor.line] ?? "";
  const beforeCursor = sliceGraphemes(current, target.startColumn, composer.cursor.column).join("");
  return { row: lines.indexOf(target), column: visibleWidth(beforeCursor) };
}

export { visibleWidth } from "./text-width.js";

export function composerCursorOffset(composer: ComposerState): number {
  let offset = 0;
  for (let index = 0; index < composer.cursor.line; index += 1) {
    offset += (composer.lines[index] ?? "").length + 1;
  }
  return offset + graphemeOffset(composer.lines[composer.cursor.line] ?? "", composer.cursor.column);
}
