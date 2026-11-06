import stringWidth from "string-width";

// eslint-disable-next-line no-control-regex -- control chars are the intended match (ANSI escape/text cleanup)
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** ASCII never forms multi-code-point grapheme clusters, so the Segmenter can be skipped entirely. */
const ASCII_ONLY_PATTERN = /^[\x00-\x7f]*$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]*$/;
export function stripTerminalMarkup(value: string): string {
  // ANSI only: overlay selection is a structured flag now, so no `{tag}` in user text is markup and
  // nothing may be stripped from it (a path holding `{main}` used to lose that segment).
  return value.replace(ANSI_PATTERN, "");
}

interface GraphemeSegmenter {
  segment(value: string): Iterable<{ segment: string }>;
}

type GraphemeSegmenterConstructor = new (
  locale?: string,
  options?: { granularity?: string },
) => GraphemeSegmenter;

const SegmenterConstructor = (
  Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }
).Segmenter;

/** Constructing an Intl.Segmenter costs far more than segmenting a short string; keep one. */
let cachedSegmenter: GraphemeSegmenter | undefined;

function graphemeSegmenter(): GraphemeSegmenter | undefined {
  if (!SegmenterConstructor) return undefined;
  cachedSegmenter ??= new SegmenterConstructor(undefined, { granularity: "grapheme" });
  return cachedSegmenter;
}

export function graphemes(value: string): string[] {
  if (ASCII_ONLY_PATTERN.test(value)) return Array.from(value);
  const segmenter = graphemeSegmenter();
  if (segmenter) return Array.from(segmenter.segment(value), (item) => item.segment);
  return Array.from(value);
}

export function graphemeWidth(value: string): number {
  // Match Ink's width rules so its wrapping does not split preformatted rows.
  return PRINTABLE_ASCII_PATTERN.test(value) ? value.length : stringWidth(value);
}

export function visibleWidth(value: string): number {
  const stripped = stripTerminalMarkup(value);
  return PRINTABLE_ASCII_PATTERN.test(stripped) ? stripped.length : stringWidth(stripped);
}

export function sliceGraphemes(value: string, start: number, end?: number): string[] {
  return graphemes(value).slice(Math.max(0, start), end === undefined ? undefined : Math.max(start, end));
}

export function graphemeLength(value: string): number {
  if (ASCII_ONLY_PATTERN.test(value)) return value.length;
  return graphemes(value).length;
}

export function graphemeOffset(value: string, index: number): number {
  return sliceGraphemes(value, 0, Math.max(0, index)).join("").length;
}

export function truncateVisible(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const stripped = stripTerminalMarkup(value);
  if (PRINTABLE_ASCII_PATTERN.test(stripped)) {
    if (stripped.length <= safeWidth) return value;
    if (safeWidth === 1) return "…";
    return `${stripped.slice(0, safeWidth - 1)}…`;
  }
  const symbols = graphemes(stripped);
  let total = 0;
  for (const symbol of symbols) total += graphemeWidth(symbol);
  if (total <= safeWidth) return value;
  if (safeWidth === 1) return "…";
  // Accumulate width in one pass; re-measuring the whole prefix per symbol is O(n²).
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

interface WrapLine {
  /** Grapheme clusters; for ASCII, one code unit each. */
  readonly symbols: string[];
  /** Display width per symbol; undefined means every symbol is one cell (ASCII fast path). */
  readonly widths: readonly number[] | undefined;
}

function wrapLineUnits(line: string): WrapLine {
  if (PRINTABLE_ASCII_PATTERN.test(line)) return { symbols: Array.from(line), widths: undefined };
  const symbols = graphemes(line);
  return { symbols, widths: symbols.map((symbol) => graphemeWidth(symbol)) };
}

interface WrappedText {
  lines: string[];
  truncated: boolean;
}

/**
 * Wrap one string. The line is segmented exactly once and the chunking walks an index, so cost is
 * linear in its length; re-segmenting the remaining suffix per chunk is quadratic and froze the UI
 * on long single-line thoughts and tool output.
 */
function wrapDisplayLines(value: string, width: number, maxLines: number): WrappedText {
  const lines: string[] = [];
  const sourceLines = stripTerminalMarkup(value).replace(/\r\n/g, "\n").split("\n");
  let truncated = false;
  const atLimit = (): boolean => lines.length >= maxLines;

  for (let sourceIndex = 0; sourceIndex < sourceLines.length; sourceIndex += 1) {
    const source = sourceLines[sourceIndex]!;
    if (!source) {
      lines.push("");
      if (atLimit() && sourceIndex < sourceLines.length - 1) {
        truncated = true;
        break;
      }
      continue;
    }
    const { symbols, widths } = wrapLineUnits(source);
    const widthAt = (index: number): number => (widths ? (widths[index] ?? 0) : 1);
    let position = 0;
    while (true) {
      let total = 0;
      for (let index = position; index < symbols.length; index += 1) total += widthAt(index);
      if (total <= width) {
        lines.push(symbols.slice(position).join(""));
        if (atLimit() && sourceIndex < sourceLines.length - 1) truncated = true;
        break;
      }
      let used = 0;
      let end = position;
      let lastSpace = -1;
      for (let index = position; index < symbols.length; index += 1) {
        const symbolWidth = widthAt(index);
        if (used + symbolWidth > width) break;
        used += symbolWidth;
        end = index + 1;
        if (symbols[index] === " ") lastSpace = index;
      }
      if (end === position) {
        // A single grapheme wider than the frame still has to make progress, untrimmed.
        lines.push(symbols[position]!);
        position += 1;
      } else {
        const splitAt = lastSpace > position ? lastSpace : end;
        const piece = symbols.slice(position, splitAt).join("").trimEnd() || symbols.slice(position, end).join("");
        lines.push(piece);
        position = splitAt;
        while (position < symbols.length && /\s/u.test(symbols[position]!)) position += 1;
      }
      if (atLimit()) {
        if (position < symbols.length || sourceIndex < sourceLines.length - 1) {
          truncated = true;
          break;
        }
        break;
      }
    }
    if (truncated) break;
  }
  return { lines, truncated };
}

export function wrapDisplayText(value: string, width: number): string[] {
  return wrapDisplayLines(value, Math.max(1, Math.floor(width)), Number.POSITIVE_INFINITY).lines;
}

/**
 * Wrap but stop once `maxLines` lines exist; when more content remains, the last line becomes "…".
 * Equivalent to slicing `wrapDisplayText`'s result, without rendering the discarded tail.
 */
export function wrapDisplayTextLimited(value: string, width: number, maxLines: number): string[] {
  const limit = Math.max(1, Math.floor(maxLines));
  const { lines, truncated } = wrapDisplayLines(value, Math.max(1, Math.floor(width)), limit);
  return truncated ? [...lines.slice(0, limit - 1), "…"] : lines;
}
