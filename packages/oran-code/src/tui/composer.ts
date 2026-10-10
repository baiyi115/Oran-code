import type { ComposerDraft, ComposerState } from "./types.js";
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

const UNDO_COALESCE_MS = 300;
const UNDO_LIMIT = 50;

/**
 * A restorable draft. Beyond the text it must also carry the cursor and the collapsed-paste
 * payloads: with text alone, ctrl+z would treat the [paste #N +M lines] placeholder as body text
 * and throw the cursor to the end of the document.
 */
function currentDraft(composer: ComposerState): ComposerDraft {
  return {
    text: composer.lines.join("\n"),
    cursor: { ...composer.cursor },
    pastes: structuredClone(composer.pastes),
  };
}

/**
 * Record a snapshot taken before a delete/insert/structural modification, for undo.
 * Same-kind operations within a short window (continuous typing, continuous deleting) coalesce
 * into one entry so a single keystroke does not occupy a whole stack level.
 */
export function pushUndoSnapshot(composer: ComposerState, op: string, now = Date.now()): void {
  const last = composer.undoMarker;
  // Adjacent same-kind **edit** operations (continuous typing/deleting) coalesce into one entry;
  // "set" whole-buffer replacements (clear/restore/replace) are discrete user actions that always
  // get their own level, or a just-cleared draft could not be rescued.
  if (last && op === last.op && op !== "set" && now - last.at < UNDO_COALESCE_MS && composer.undo.length) {
    composer.undoMarker = { at: now, op };
    return;
  }
  composer.undo.push(currentDraft(composer));
  if (composer.undo.length > UNDO_LIMIT) composer.undo.shift();
  composer.undoMarker = { at: now, op };
  composer.redo.length = 0;
}

function applyUndoTarget(composer: ComposerState, draft: ComposerDraft): void {
  const lines = draft.text.replace(/\r\n/g, "\n").split("\n");
  composer.lines = lines.length ? lines : [""];
  composer.pastes = structuredClone(draft.pastes);
  const line = Math.min(Math.max(0, draft.cursor.line), composer.lines.length - 1);
  const column = Math.min(draft.cursor.column, graphemeLength(composer.lines[line] ?? ""));
  composer.cursor = { line, column };
  composer.preferredDisplayColumn = undefined;
}

export function composerUndo(composer: ComposerState): boolean {
  const previous = composer.undo.pop();
  if (previous === undefined) return false;
  composer.redo.push(currentDraft(composer));
  if (composer.redo.length > UNDO_LIMIT) composer.redo.shift();
  applyUndoTarget(composer, previous);
  composer.undoMarker = { at: 0, op: "restore" };
  return true;
}

export function composerRedo(composer: ComposerState): boolean {
  const next = composer.redo.pop();
  if (next === undefined) return false;
  composer.undo.push(currentDraft(composer));
  if (composer.undo.length > UNDO_LIMIT) composer.undo.shift();
  applyUndoTarget(composer, next);
  composer.undoMarker = { at: 0, op: "restore" };
  return true;
}

function isWordChar(value: string): boolean {
  return value.length > 0 && /[A-Za-z0-9_]/.test(value);
}

/** Find the left boundary of the "current word" scanning back from column (matches moveWordBackward). */
function wordBackwardIndex(symbols: readonly string[], column: number): number {
  while (column > 0 && !isWordChar(symbols[column - 1] ?? "")) column -= 1;
  while (column > 0 && isWordChar(symbols[column - 1] ?? "")) column -= 1;
  return column;
}

export function moveWordBackward(composer: ComposerState): void {
  const symbols = graphemes(composer.lines[composer.cursor.line] ?? "");
  // First cross the non-word chars before the cursor, then jump to the word's head (readline semantics).
  composer.cursor.column = wordBackwardIndex(symbols, composer.cursor.column);
  composer.preferredDisplayColumn = undefined;
}

export function moveWordForward(composer: ComposerState): void {
  const symbols = graphemes(composer.lines[composer.cursor.line] ?? "");
  let column = composer.cursor.column;
  // Consume the rest of the current word, then the non-word chars, landing at the next word's start.
  while (column < symbols.length && isWordChar(symbols[column] ?? "")) column += 1;
  while (column < symbols.length && !isWordChar(symbols[column] ?? "")) column += 1;
  composer.cursor.column = column;
  composer.preferredDisplayColumn = undefined;
}

/** Delete by word (readline's Ctrl+W); no cross-line merge, matching deleteBackward's line merge. */
export function deleteWordBackward(composer: ComposerState): void {
  if (composer.cursor.column === 0) {
    deleteBackward(composer);
    return;
  }
  pushUndoSnapshot(composer, "delete");
  const symbols = graphemes(composer.lines[composer.cursor.line] ?? "");
  const boundary = wordBackwardIndex(symbols, composer.cursor.column);
  composer.lines[composer.cursor.line] = symbols
    .slice(0, boundary)
    .concat(symbols.slice(composer.cursor.column))
    .join("");
  composer.cursor.column = boundary;
  composer.preferredDisplayColumn = undefined;
}

export function insertText(composer: ComposerState, value: string): void {
  pushUndoSnapshot(composer, "insert");
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
  pushUndoSnapshot(composer, "delete");
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
  pushUndoSnapshot(composer, "delete");
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
