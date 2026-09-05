// eslint-disable-next-line no-control-regex -- 控制字符是刻意匹配的目标（ANSI 转义/文本清洗）
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export function stripTerminalMarkup(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(INK_TAG_PATTERN, "");
}

export function graphemes(value: string): string[] {
  const segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale?: string,
        options?: { granularity?: string },
      ) => {
        segment(value: string): Iterable<{ segment: string }>;
      };
    }
  ).Segmenter;
  if (segmenter) {
    return Array.from(new segmenter(undefined, { granularity: "grapheme" }).segment(value), (item) => item.segment);
  }
  return Array.from(value);
}

export function graphemeWidth(value: string): number {
  const symbols = Array.from(value);
  let width = 0;
  let hasWideSymbol = false;
  for (const symbol of symbols) {
    const code = symbol.codePointAt(0) ?? 0;
    if (isCombining(code) || isVariationSelector(code) || isEmojiModifier(code) || code === 0x200d) continue;
    if (isWide(code)) hasWideSymbol = true;
    width += isWide(code) ? 2 : 1;
  }
  if (symbols.length > 1 && symbols.some((symbol) => (symbol.codePointAt(0) ?? 0) === 0x200d)) return 2;
  return hasWideSymbol ? Math.max(2, width) : width;
}

export function visibleWidth(value: string): number {
  return graphemes(stripTerminalMarkup(value)).reduce((total, symbol) => total + graphemeWidth(symbol), 0);
}

export function sliceByDisplayWidth(value: string, start: number, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const symbols = graphemes(value).slice(start);
  let used = 0;
  let result = "";
  for (const symbol of symbols) {
    const next = graphemeWidth(symbol);
    if (used + next > safeWidth) break;
    result += symbol;
    used += next;
  }
  return result || (symbols[0] ?? "");
}

export function displayWidthSlice(value: string, start: number, end: number): string {
  return sliceGraphemes(value, start, end).join("");
}

export function sliceGraphemes(value: string, start: number, end?: number): string[] {
  return graphemes(value).slice(Math.max(0, start), end === undefined ? undefined : Math.max(start, end));
}

export function graphemeLength(value: string): number {
  return graphemes(value).length;
}

export function graphemeOffset(value: string, index: number): number {
  return sliceGraphemes(value, 0, Math.max(0, index)).join("").length;
}

export function graphemeIndexAtOffset(value: string, offset: number): number {
  const safeOffset = Math.max(0, Math.min(value.length, Math.floor(offset)));
  return graphemes(value.slice(0, safeOffset)).length;
}

export function truncateVisible(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const symbols = graphemes(stripTerminalMarkup(value));
  let total = 0;
  for (const symbol of symbols) total += graphemeWidth(symbol);
  if (total <= safeWidth) return value;
  if (safeWidth === 1) return "…";
  // 单遍累计宽度;逐符号重测整个前缀是 O(n²)。
  let used = 0;
  let result = "";
  for (const symbol of symbols) {
    const symbolWidth = graphemeWidth(symbol);
    if (used + symbolWidth + 1 > safeWidth) break;
    result += symbol;
    used += symbolWidth;
  }
  return `${result}…`;
}

/**
 * Shorten a long path by keeping the drive/root and the trailing segments,
 * collapsing the middle: "D:\Programming\project\Oran code" -> "D:\...\project\Oran code".
 */
export function abbreviatePath(path: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (visibleWidth(path) <= safeWidth) return path;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return truncateVisible(path, safeWidth);
  const head = parts[0]!;
  const ellipsis = "...";
  let tail: string[] = [];
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const candidate = [...tail, parts[index]!].join("\\");
    if (visibleWidth(`${head}\\${ellipsis}\\${candidate}`) > safeWidth) {
      if (tail.length === 0) {
        // Even the last segment alone does not fit; fall back to tail truncation.
        return truncateVisible(`${head}\\${ellipsis}\\${parts[index]}`, safeWidth);
      }
      break;
    }
    tail = [parts[index]!, ...tail];
  }
  return `${head}\\${ellipsis}\\${tail.join("\\")}`;
}

export function wrapDisplayText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return stripTerminalMarkup(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [""];
      const output: string[] = [];
      let remaining = line;
      while (true) {
        // 每行只做一次分词;对剩余串反复全量测量是 O(n²)。
        const symbols = graphemes(remaining);
        let total = 0;
        for (const symbol of symbols) total += graphemeWidth(symbol);
        if (total <= safeWidth) {
          output.push(remaining);
          break;
        }
        let used = 0;
        let end = 0;
        let lastSpace = -1;
        for (let index = 0; index < symbols.length; index += 1) {
          const symbol = symbols[index]!;
          const symbolWidth = graphemeWidth(symbol);
          if (used + symbolWidth > safeWidth) break;
          used += symbolWidth;
          end = index + 1;
          if (symbol === " ") lastSpace = index;
        }
        if (!end) {
          output.push(symbols.slice(0, 1).join(""));
          remaining = symbols.slice(1).join("");
          continue;
        }
        const splitAt = lastSpace > 0 ? lastSpace : end;
        const piece = symbols.slice(0, splitAt).join("").trimEnd() || symbols.slice(0, end).join("");
        output.push(piece);
        remaining = symbols.slice(splitAt).join("").trimStart();
      }
      return output;
    });
}

function isCombining(code: number): boolean {
  return (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x591 && code <= 0x5bd) ||
    (code >= 0x610 && code <= 0x61a) ||
    (code >= 0x64b && code <= 0x652) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isVariationSelector(code: number): boolean {
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isEmojiModifier(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff;
}

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f000 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

// `{inverse}...{/inverse}` selection tags are produced by overlay selectors and
// parsed by the Ink renderer; strip them here so width math ignores tag markup.
const INK_TAG_PATTERN = /\{\/?[a-zA-Z0-9_#= -]+\}/g;
