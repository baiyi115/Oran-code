import { describe, expect, it } from "vitest";
import { KEYBINDINGS, matchesAnyKey, matchesKey } from "../src/tui/keybindings.js";

describe("TUI keybindings", () => {
  it("matches named and modified terminal key events", () => {
    expect(matchesKey({ name: "up" }, KEYBINDINGS.moveUp)).toBe(true);
    expect(matchesKey({ name: "j", ctrl: true }, KEYBINDINGS.insertNewline[1])).toBe(true);
    expect(matchesKey({ name: "enter", shift: true }, KEYBINDINGS.insertNewline[0])).toBe(true);
    expect(matchesKey({ name: "tab", shift: false }, KEYBINDINGS.switchWorkMode)).toBe(true);
    expect(matchesAnyKey({ name: "j", ctrl: true }, KEYBINDINGS.insertNewline)).toBe(true);
    expect(matchesKey({ name: "j" }, KEYBINDINGS.insertNewline[1])).toBe(false);
  });

  it("keeps composer command keys in one declarative table", () => {
    expect(KEYBINDINGS).toMatchObject({
      moveLeft: "left",
      moveRight: "right",
      moveToStart: "home",
      moveToEnd: "end",
      deleteBackward: "backspace",
      deleteForward: "delete",
    });
  });
});
