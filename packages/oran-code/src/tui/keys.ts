import type { Key } from "ink";
import { FORWARD_DELETE_SEQUENCE } from "./terminal-streams.js";

/** Unified key predicates: Ink's Key flags differ per terminal, so compatibility lives here. */

export function isSubmitKey(input: string, key: Key): boolean {
  // Ink only marks CR as return; some terminals still deliver bare LF on Enter.
  return key.return || input === "\n" || input === "\r";
}

export function isSessionDeleteKey(input: string, key: Key): boolean {
  // Physical Delete is rewritten by the input transform, so it arrives as the marker here too.
  return (key.ctrl && input === "d") || key.delete || key.backspace || input === FORWARD_DELETE_SEQUENCE;
}

export function isHomeKey(input: string, key: Key): boolean {
  // Ink has no home flag and blanks `input` for the sequence; the input transform rewrites physical
  // Home to Ctrl+A before it reaches the app (see KEY_SEQUENCE_REWRITES in terminal-streams.ts).
  return key.ctrl === true && input === "a";
}

export function isEndKey(input: string, key: Key): boolean {
  // Physical End arrives as Ctrl+E, for the same reason as Home above.
  return key.ctrl === true && input === "e";
}

export function isDeleteBackward(_input: string, key: Key): boolean {
  // Ink clears `input` for the backspace key (raw DEL 0x7f) and reports it as `delete`, so both
  // flags erase backward; forward delete no longer shares the flag (it has its own marker).
  return key.backspace || key.delete;
}

export function isDeleteForward(input: string): boolean {
  return input === FORWARD_DELETE_SEQUENCE;
}
