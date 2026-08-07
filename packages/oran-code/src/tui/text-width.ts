const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export function stripTerminalMarkup(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(BLESSED_TAG_PATTERN, "");
}

export function graphemes(value: string): string[] {
  const segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity?: string }) => {
      segment(value: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;
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
  if (visibleWidth(value) <= safeWidth) return value;
  if (safeWidth === 1) return "…";
  let result = "";
  for (const symbol of graphemes(value)) {
    if (visibleWidth(`${result}${symbol}…`) > safeWidth) break;
    result += symbol;
  }
  return `${result}…`;
}

export function wrapDisplayText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return stripTerminalMarkup(value).replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    if (!line) return [""];
    const output: string[] = [];
    let remaining = line;
    while (visibleWidth(remaining) > safeWidth) {
      const chunk = sliceByDisplayWidth(remaining, 0, safeWidth);
      let splitAt = chunk.length;
      const whitespace = chunk.lastIndexOf(" ");
      if (whitespace > 0) splitAt = whitespace;
      const piece = remaining.slice(0, splitAt).trimEnd();
      output.push(piece || chunk);
      remaining = remaining.slice(splitAt).trimStart();
      if (!splitAt) remaining = remaining.slice(chunk.length);
    }
    output.push(remaining);
    return output;
  });
}

function isCombining(code: number): boolean {
  return (code >= 0x300 && code <= 0x36f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe20 && code <= 0xfe2f);
}

function isVariationSelector(code: number): boolean {
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isEmojiModifier(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff;
}

function isWide(code: number): boolean {
  return code >= 0x1100
    && (code <= 0x115f
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff));
}

const BLESSED_TAG_PATTERN = /\{\/?[a-zA-Z0-9_#= -]+\}/g;
