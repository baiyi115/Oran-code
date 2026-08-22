import { describe, expect, it } from "vitest";
import { isDeleteBackward, isDeleteForward, isEndKey, isHomeKey, isSessionDeleteKey, isSubmitKey } from "../src/tui/keys.js";
import type { Key } from "ink";

function key(partial: Partial<Key> = {}, input = ""): Key {
  return partial as Key;
}

describe("TUI key predicates", () => {
  it("treats CR, bare LF, and ink return as submit", () => {
    expect(isSubmitKey("", { return: true } as Key)).toBe(true);
    expect(isSubmitKey("\n", key())).toBe(true);
    expect(isSubmitKey("\r", key())).toBe(true);
    expect(isSubmitKey("a", key())).toBe(false);
  });

  it("recognizes session delete via ctrl+d, delete, and backspace", () => {
    expect(isSessionDeleteKey("d", { ctrl: true } as Key)).toBe(true);
    expect(isSessionDeleteKey("", { delete: true } as Key)).toBe(true);
    expect(isSessionDeleteKey("", { backspace: true } as Key)).toBe(true);
    expect(isSessionDeleteKey("d", key())).toBeFalsy();
  });

  it("accepts ctrl+a and common home/end escape sequences", () => {
    expect(isHomeKey("a", { ctrl: true } as Key)).toBe(true);
    expect(isHomeKey("\x1b[H", key())).toBe(true);
    expect(isEndKey("e", { ctrl: true } as Key)).toBe(true);
    expect(isEndKey("\x1b[F", key())).toBe(true);
    expect(isHomeKey("a", key())).toBe(false);
  });

  it("erases backward for both backspace and Windows-style delete", () => {
    expect(isDeleteBackward("", { backspace: true } as Key)).toBe(true);
    // Windows physical Backspace often arrives as bare DEL without backspace flag.
    expect(isDeleteBackward("", { delete: true } as Key)).toBe(true);
  });

  it("erases forward only for explicit forward-delete sequences", () => {
    expect(isDeleteForward("\x1b[3~", { delete: true } as Key)).toBe(true);
    // Bare DEL (short input) stays backward; backspace never deletes forward.
    expect(isDeleteForward("", { delete: true } as Key)).toBe(false);
    expect(isDeleteForward("\x1b[3~", { backspace: true, delete: true } as Key)).toBe(false);
  });
});
