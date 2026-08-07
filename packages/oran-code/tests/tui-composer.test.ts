import { describe, expect, it } from "vitest";
import { cursorVisualPosition, deleteBackward, deleteForward, insertText, moveCursor, visualLines } from "../src/tui/composer.js";
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
