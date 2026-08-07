import type { ComposerState } from "../types.js";
import { composerValue, createComposerState, setComposerValue } from "../state.js";
import { setComposerCursorOffset } from "../composer.js";

export function createEditorState(history: readonly string[] = []): ComposerState {
  return createComposerState(history);
}

export function replaceEditorValue(state: ComposerState, value: string, cursorOffset = value.length): void {
  setComposerValue(state, value);
  setComposerCursorOffset(state, cursorOffset);
}

export function editorValue(state: ComposerState): string {
  return composerValue(state);
}
