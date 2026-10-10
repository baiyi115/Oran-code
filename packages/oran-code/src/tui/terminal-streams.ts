import { Transform } from "node:stream";

export const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
export const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
/**
 * Button press/release + SGR extended coordinates,小号范围:只接管点击与
 * 滚轮,不抓 motion(1002/1003)以控制帧率;代价是原生文本选择需 Shift+拖选。
 */
export const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1006h";

export interface TerminalMouseEvent {
  /** SGR button code;bit 6 (64) marks wheel events,bit 0-1 = direction/button。 */
  readonly button: number;
  /** 0-based column. */
  readonly x: number;
  /** 0-based row. */
  readonly y: number;
  /** SGR release report ('m' terminator);滚轮事件通常只有 press。 */
  readonly release: boolean;
}

export interface TerminalInputHooks {
  readonly onMouse?: (event: TerminalMouseEvent) => void;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

const SGR_MOUSE_PREFIX = "\x1b[<";
const LEGACY_MOUSE_PREFIX = "\x1b[M";
/** 拦截为 40ms 内的跨 chunk 拆分兜底;超时按普通按键透传,避免吞掉真实输入。 */
const MOUSE_PREFIX_FLUSH_MS = 40;

const SGR_MOUSE_SEQUENCE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const LEGACY_MOUSE_SEQUENCE = /\x1b\[M[\s\S]{3}/g;

interface MouseStripResult {
  readonly text: string;
  readonly events: TerminalMouseEvent[];
}

/**
 * 从原始输入块中剥离完整的鼠标上报(SGR 1006 与旧版 X10 编码),返回剩余
 * 按键文本与解析后的事件。只识别完整序列;不完整的前缀由调用方跨 chunk 缓冲。
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

/** 找出 chunk 尾部可能是鼠标序列开头的部分(跨 chunk 拆分时交给下一次读取)。 */
function trailingMousePrefix(text: string): string {
  // 一次键盘输入打不出这些前缀;延迟 40ms 透传不会影响手感。
  const sgr = /\x1b\[<[0-9;]*$/.exec(text);
  if (sgr) return sgr[0];
  const legacy = /\x1b\[M[\s\S]{0,2}$/.exec(text);
  if (legacy) return legacy[0];
  const opening = /\x1b\[[<M]?$/.exec(text);
  if (opening) return opening[0];
  return "";
}

/**
 * 透传签名刻意放宽：chunk/encoding/cb 的实际组合由调用方决定，拦截层不做静态约束。
 * 必须 bind，否则裸函数调用会丢掉 write 依赖的 stream 上下文。
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
 * 附带(可选)的鼠标上报拦截:开启 1006h 后终端会往 stdin 写 SGR/X10 鼠标
 * 序列,Ink 的 keypress 解析器会把它们拆成一串垃圾按键灌进 composer,所以
 * 必须在到达 Ink 之前剥离并交给 onMouse。粘帖帧内的字节一律放行。
 */
export function createBracketedPasteStream(
  source: NodeJS.ReadableStream,
  hooks?: TerminalInputHooks,
): NodeJS.ReadableStream {
  let inPaste = false;
  let pasteBuffer = "";
  let timeoutTimer: NodeJS.Timeout | undefined;
  let mousePrefix = "";
  let mouseFlushTimer: NodeJS.Timeout | undefined;

  const transform = new Transform({
    decodeStrings: false,
    transform(chunk, _encoding, callback) {
      let str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

      // 把"粘帖帧外"的一段做完鼠标清洗再吐出;帧内字节是数据,一律放行。
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
            // 观察者异常不得阻塞输入管线
          }
        }
        const held = trailingMousePrefix(text);
        if (held) {
          mousePrefix = held;
          if (mouseFlushTimer) clearTimeout(mouseFlushTimer);
          // 前缀不完整就等待下一个 chunk;超时的前缀按真实按键放行。
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
      // 源收尾时把挂起的鼠标前缀按普通按键放行,绝不能静默丢失用户输入。
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
  }) as NodeJS.ReadableStream;
}
