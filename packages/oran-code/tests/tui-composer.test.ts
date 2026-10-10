import { describe, expect, it } from "vitest";
import {
  composerRedo,
  composerUndo,
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  insertText,
  moveCursor,
  moveWordBackward,
  moveWordForward,
  visualLines,
} from "../src/tui/composer.js";
import { composerValue, createComposerState, setComposerValue } from "../src/tui/state.js";

describe("TUI composer editing", () => {
  it("moves up and down by visual rows while preserving the preferred column", () => {
    const state = createComposerState();
    setComposerValue(state, "abcdefgh\nxy");
    state.cursor = { line: 0, column: 1 };

    expect(visualLines(state, 4).map((line) => [line.text, line.logicalLine, line.startColumn])).toEqual([
      ["abcd", 0, 0],
      ["efgh", 0, 4],
      ["xy", 1, 0],
    ]);

    moveCursor(state, "down", 4);
    expect(state.cursor).toEqual({ line: 0, column: 5 });
    moveCursor(state, "down", 4);
    expect(state.cursor).toEqual({ line: 1, column: 1 });
    moveCursor(state, "up", 4);
    expect(state.cursor).toEqual({ line: 0, column: 5 });
    expect(cursorVisualPosition(state, 4)).toEqual({ row: 1, column: 1 });
  });

  it("inserts pasted multiline content as one edit and preserves grapheme boundaries", () => {
    const state = createComposerState();
    insertText(state, "中🙂");
    insertText(state, "\r\nnext");

    expect(composerValue(state)).toBe("中🙂\nnext");
    expect(state.cursor).toEqual({ line: 1, column: 4 });

    deleteBackward(state);
    expect(composerValue(state)).toBe("中🙂\nnex");
    deleteForward(state);
    expect(composerValue(state)).toBe("中🙂\nnex");
    state.cursor = { line: 0, column: 2 };
    deleteBackward(state);
    expect(composerValue(state)).toBe("中\nnex");
  });

  it("handles newline and deletion at logical line boundaries", () => {
    const state = createComposerState();
    setComposerValue(state, "one");
    state.cursor = { line: 0, column: 1 };
    insertText(state, "\n");
    expect(state.lines).toEqual(["o", "ne"]);
    deleteBackward(state);
    expect(state.lines).toEqual(["one"]);
    deleteForward(state);
    expect(state.lines).toEqual(["one"]);
  });
});

describe("composer undo / redo", () => {
  it("undo and redo round-trip through typed text", () => {
    const state = createComposerState();
    insertText(state, "hello ");
    // 同类型输入在短时间内合并入一段:一次 undo 把整段文本全部撤销。
    insertText(state, "world");

    expect(composerUndo(state)).toBe(true);
    expect(composerValue(state)).toBe("");
    expect(composerUndo(state)).toBe(false);

    expect(composerRedo(state)).toBe(true);
    expect(composerValue(state)).toBe("hello world");
    expect(composerRedo(state)).toBe(false);
  });

  it("coalesces consecutive same-op keystrokes into one undo segment", async () => {
    const state = createComposerState();
    insertText(state, "first");
    insertText(state, "second");
    expect(composerUndo(state)).toBe(true);
    expect(composerValue(state)).toBe("");
    expect(composerUndo(state)).toBe(false);
  });

  it("recovers a cleared draft via undo (idle-Esc protection)", () => {
    const state = createComposerState();
    setComposerValue(state, "a carefully written prompt with details");
    setComposerValue(state, "");
    expect(composerValue(state)).toBe("");
    expect(composerUndo(state)).toBe(true);
    expect(composerValue(state)).toBe("a carefully written prompt with details");
  });
});

describe("word-level editing", () => {
  it("moves by word boundaries in both directions", () => {
    const state = createComposerState();
    setComposerValue(state, "fix the  loop quickly");
    state.cursor = { line: 0, column: "fix the  loop quickly".length };
    moveWordBackward(state);
    expect(state.cursor.column).toBe(14);
    moveWordBackward(state);
    expect(state.cursor.column).toBe(9);
    moveWordBackward(state);
    expect(state.cursor.column).toBe(4);
    moveWordForward(state);
    expect(state.cursor.column).toBe(9);
    moveWordForward(state);
    expect(state.cursor.column).toBe(14);
  });

  it("deletes only the current word backward", () => {
    const state = createComposerState();
    setComposerValue(state, "keep these words");
    deleteWordBackward(state);
    expect(composerValue(state)).toBe("keep these ");
    expect(state.cursor.column).toBe(11);
    deleteWordBackward(state);
    expect(composerValue(state)).toBe("keep ");
  });
});
