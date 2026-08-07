import type { ComposerState } from "../types.js";
import {
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  insertText,
  moveCursor,
  moveToLineEdge,
  visualLines,
} from "../composer.js";

export const editor = {
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  insertText,
  moveCursor,
  moveToLineEdge,
  visualLines,
};

export function insertNewline(state: ComposerState): void {
  insertText(state, "\n");
}
