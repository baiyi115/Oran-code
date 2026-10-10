import { Transform } from "node:stream";

export const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
export const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
/**
 * Button press/release + SGR extended coordinates, a small scope: only clicks and the wheel are
 * handled, motion (1002/1003) is left alone to keep the frame rate down; the price is that
 * native text selection needs Shift+drag.
 */
export const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1006h";

export interface TerminalMouseEvent {
  /** SGR button code; bit 6 (64) marks wheel events, bits 0-1 = direction/button. */
  readonly button: number;
  /** 0-based column. */
  readonly x: number;
  /** 0-based row. */
  readonly y: number;
  /** SGR release report ('m' terminator); wheel events usually only send press. */
  readonly release: boolean;
}

export interface TerminalInputHooks {
  readonly onMouse?: (event: TerminalMouseEvent) => void;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Held prefix flushes after 40ms; past that it passes through as plain keys so real input survives. */
const MOUSE_PREFIX_FLUSH_MS = 40;

const SGR_MOUSE_SEQUENCE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const LEGACY_MOUSE_SEQUENCE = /\x1b\[M[\s\S]{3}/g;

interface MouseStripResult {
  readonly text: string;
  readonly events: TerminalMouseEvent[];
}

/**
 * Strip complete mouse reports (SGR 1006 and legacy X10 encodings) from a raw input chunk and
 * return the remaining key text plus the parsed events. Only complete sequences are recognized;
 * incomplete prefixes are buffered across chunks by the caller.
 */
function stripMouseSequences(text: string): MouseStripResult {
  const events: TerminalMouseEvent[] = [];
  let clean = text.replace(SGR_MOUSE_SEQUENCE, (_match, button, x, y, terminator) => {
    events.push({
      button: Number.parseInt(button, 10),
      x: Math.max(0, Number.parseInt(x, 10) - 1),
      y: Math.max(0, Number.parseInt(y, 10) - 1),
      release: terminator === "m",
    });
    return "";
  });
  clean = clean.replace(LEGACY_MOUSE_SEQUENCE, (match) => {
    events.push({
      button: match.charCodeAt(3) - 32,
      x: Math.max(0, match.charCodeAt(4) - 33),
      y: Math.max(0, match.charCodeAt(5) - 33),
      release: false,
    });
    return "";
  });
  return { text: clean, events };
}

/** Find the chunk-tail part that may start a mouse sequence (handed to the next read when split). */
function trailingMousePrefix(text: string): string {
  // A single keystroke cannot produce these prefixes; delaying 40ms before passing through is fine.
  const sgr = /\x1b\[<[0-9;]*$/.exec(text);
  if (sgr) return sgr[0];
  const legacy = /\x1b\[M[\s\S]{0,2}$/.exec(text);
  if (legacy) return legacy[0];
  const opening = /\x1b\[[<M]?$/.exec(text);
  if (opening) return opening[0];
  return "";
}

/**
 * The pass-through signature is deliberately loose: the actual chunk/encoding/cb combination is
 * decided by the caller and the intercepting layer adds no static constraint.
 * It must be bound, otherwise a bare call loses the stream context that write depends on.
 */
type RawWrite = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;

/**
 * Wraps a WriteStream with CSI 2026 synchronized output brackets.
 * When supported by the terminal emulator (Windows Terminal, iTerm2, WezTerm,
 * Alacritty, Ghostty, Foot, Kitty), all updates between 2026h and 2026l are
 * rendered atomically in a single screen refresh, eliminating tearing and flicker.
 */
export function createSynchronizedWriteStream(target: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = target.write.bind(target) as unknown as RawWrite;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "write") {
        return (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
          if (!target.isTTY) {
            return write(chunk, encoding, cb);
          }
          const str =
            typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);

          if (!str || str.startsWith(BEGIN_SYNCHRONIZED_OUTPUT)) {
            return write(chunk, encoding, cb);
          }

          const callback = typeof encoding === "function" ? encoding : typeof cb === "function" ? cb : undefined;
          const enc = typeof encoding === "string" ? encoding : undefined;

          return write(`${BEGIN_SYNCHRONIZED_OUTPUT}${str}${END_SYNCHRONIZED_OUTPUT}`, enc, callback);
        };
      }
      const val = Reflect.get(obj, prop, receiver);
      return typeof val === "function" ? val.bind(obj) : val;
    },
  });
}

/**
 * Wraps a ReadableStream to intercept Bracketed Paste sequences.
 * When the terminal sends pasted text wrapped between \x1b[200~ and \x1b[201~,
 * all intermediate chunks are buffered together and emitted as a single chunk
 * with the escape sequences stripped out. This prevents multiline pastes from
 * prematurely firing Enter / keypress handlers before the full paste arrives.
 *
 * Optional extra mouse-report interception: once 1006h is enabled the terminal writes SGR/X10
 * mouse sequences to stdin, and Ink's keypress parser would split them into a stream of garbage
 * keys fed to the composer, so they must be stripped and handed to onMouse before reaching Ink.
 * Bytes inside a paste frame are always passed through.
 */
export function createBracketedPasteStream(source: NodeJS.ReadableStream, hooks?: TerminalInputHooks): Transform {
  let inPaste = false;
  let pasteBuffer = "";
  let timeoutTimer: NodeJS.Timeout | undefined;
  let mousePrefix = "";
  let mouseFlushTimer: NodeJS.Timeout | undefined;

  const transform = new Transform({
    decodeStrings: false,
    transform(chunk, _encoding, callback) {
      let str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

      // Mouse-clean an "outside a paste frame" segment before pushing it; in-frame bytes are data.
      const pushOutsidePaste = (segment: string): void => {
        if (!hooks?.onMouse) {
          if (segment) this.push(segment);
          return;
        }
        const input = mousePrefix + segment;
        mousePrefix = "";
        const { text, events } = stripMouseSequences(input);
        for (const event of events) {
          try {
            hooks.onMouse(event);
          } catch {
            // An observer exception must not stall the input pipeline.
          }
        }
        const held = trailingMousePrefix(text);
        if (held) {
          mousePrefix = held;
          if (mouseFlushTimer) clearTimeout(mouseFlushTimer);
          // An incomplete prefix waits for the next chunk; a timed-out prefix is released as real keys.
          mouseFlushTimer = setTimeout(() => {
            if (mousePrefix) {
              transform.push(mousePrefix);
              mousePrefix = "";
            }
          }, MOUSE_PREFIX_FLUSH_MS);
          mouseFlushTimer.unref?.();
        }
        const clean = held ? text.slice(0, text.length - held.length) : text;
        if (clean) this.push(clean);
      };

      while (str.length > 0) {
        if (!inPaste) {
          const startIdx = str.indexOf(BRACKETED_PASTE_START);
          if (startIdx === -1) {
            pushOutsidePaste(str);
            break;
          }
          if (startIdx > 0) {
            pushOutsidePaste(str.slice(0, startIdx));
          }
          inPaste = true;
          pasteBuffer = "";
          str = str.slice(startIdx + BRACKETED_PASTE_START.length);

          if (timeoutTimer) clearTimeout(timeoutTimer);
          // Safety timeout in case a broken terminal never sent the end sequence
          timeoutTimer = setTimeout(() => {
            if (inPaste && pasteBuffer.length > 0) {
              transform.push(pasteBuffer);
              pasteBuffer = "";
              inPaste = false;
            }
          }, 1000);
        } else {
          const endIdx = str.indexOf(BRACKETED_PASTE_END);
          if (endIdx === -1) {
            pasteBuffer += str;
            break;
          }
          pasteBuffer += str.slice(0, endIdx);
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          this.push(pasteBuffer);
          pasteBuffer = "";
          inPaste = false;
          str = str.slice(endIdx + BRACKETED_PASTE_END.length);
        }
      }
      callback();
    },
    flush(callback) {
      // On source end, release a pending mouse prefix as plain keys; user input is never dropped silently.
      if (mousePrefix) {
        this.push(mousePrefix);
        mousePrefix = "";
      }
      if (mouseFlushTimer) clearTimeout(mouseFlushTimer);
      callback();
    },
  });

  source.pipe(transform);

  return new Proxy(transform, {
    get(target, prop, receiver) {
      if (prop in target) {
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      }
      const sourceVal = Reflect.get(source, prop);
      return typeof sourceVal === "function" ? sourceVal.bind(source) : sourceVal;
    },
  }) as Transform;
}
