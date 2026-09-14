import { Transform } from "node:stream";

export const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
export const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Wraps a WriteStream with CSI 2026 synchronized output brackets.
 * When supported by the terminal emulator (Windows Terminal, iTerm2, WezTerm,
 * Alacritty, Ghostty, Foot, Kitty), all updates between 2026h and 2026l are
 * rendered atomically in a single screen refresh, eliminating tearing and flicker.
 */
export function createSynchronizedWriteStream(target: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "write") {
        return (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
          if (!target.isTTY) {
            return (target.write as any)(chunk, encoding, cb);
          }
          const str =
            typeof chunk === "string"
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString("utf8")
                : String(chunk);

          if (!str || str.startsWith(BEGIN_SYNCHRONIZED_OUTPUT)) {
            return (target.write as any)(chunk, encoding, cb);
          }

          const callback =
            typeof encoding === "function" ? encoding : typeof cb === "function" ? cb : undefined;
          const enc = typeof encoding === "string" ? encoding : undefined;

          return (target.write as any)(
            `${BEGIN_SYNCHRONIZED_OUTPUT}${str}${END_SYNCHRONIZED_OUTPUT}`,
            enc,
            callback,
          );
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
 */
export function createBracketedPasteStream(source: NodeJS.ReadableStream): NodeJS.ReadableStream {
  let inPaste = false;
  let pasteBuffer = "";
  let timeoutTimer: NodeJS.Timeout | undefined;

  const transform = new Transform({
    decodeStrings: false,
    transform(chunk, _encoding, callback) {
      let str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

      while (str.length > 0) {
        if (!inPaste) {
          const startIdx = str.indexOf(BRACKETED_PASTE_START);
          if (startIdx === -1) {
            this.push(str);
            break;
          }
          if (startIdx > 0) {
            this.push(str.slice(0, startIdx));
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
  }) as NodeJS.ReadableStream;
}
