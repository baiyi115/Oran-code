import type { Key } from "ink";

/** 键判定的统一实现:Ink 的 Key 标志在各终端表现不一,集中兼容。 */

export function isSubmitKey(input: string, key: Key): boolean {
  // Ink only marks CR as return; some terminals still deliver bare LF on Enter.
  return key.return || input === "\n" || input === "\r";
}

export function isSessionDeleteKey(input: string, key: Key): boolean {
  return (key.ctrl && input === "d") || key.delete || key.backspace;
}

export function isHomeKey(input: string, key: Key): boolean {
  // Ink Key has no home flag; accept Ctrl+A and common terminal sequences.
  return (key.ctrl && input === "a") || input === "\x1b[H" || input === "\x1b[1~" || input === "\x1bOH";
}

export function isEndKey(input: string, key: Key): boolean {
  // Ink Key has no end flag; accept Ctrl+E and common terminal sequences.
  return (key.ctrl && input === "e") || input === "\x1b[F" || input === "\x1b[4~" || input === "\x1bOF";
}

export function isDeleteBackward(_input: string, key: Key): boolean {
  // Ink clears `input` for non-alphanumeric keys. On Windows, physical Backspace is
  // usually reported as key.delete (raw DEL 0x7f), so both flags must erase backward.
  return key.backspace || key.delete;
}

export function isDeleteForward(input: string, key: Key): boolean {
  // Prefer backward delete for bare Windows Backspace/DEL.
  // Treat explicit forward-delete sequences (often delivered as "\x1b[3~") as forward.
  if (key.backspace) return false;
  if (input === "\x1b[3~" || input === "\x1b[3;1~") return true;
  // Some hosts set delete without backspace for Fn+Backspace / Del.
  return Boolean(key.delete && input.length > 1);
}
