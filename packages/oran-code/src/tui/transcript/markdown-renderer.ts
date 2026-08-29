import { ANSI } from "../theme.js";
import { graphemeWidth, graphemes, stripTerminalMarkup, visibleWidth } from "../text-width.js";

interface FenceState {
  marker: "`" | "~";
  length: number;
}

interface Heading {
  level: number;
  body: string;
}

type TableAlignment = "left" | "center" | "right";

export interface MarkdownRenderOptions {
  streaming?: boolean;
}

type InlineColor = "orange" | "amber" | "gray";

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  color?: InlineColor;
}

interface InlineSegment {
  text: string;
  style: InlineStyle;
}

interface InlineUnit {
  text: string;
  style: InlineStyle;
}

/**
 * Completed Markdown blocks are cached while the current tail is rendered by
 * the tolerant streaming parser. This keeps long paragraphs and list items
 * visible as they arrive without exposing incomplete Markdown delimiters.
 */
export class MarkdownRenderer {
  private width = 0;
  private sourceValue = "";
  private normalizedValue = "";
  private scanOffset = 0;
  private scanFence: FenceState | undefined;
  private stableEnd = 0;
  private stablePrefix = "";
  private stableLines: string[] = [];

  render(value: string, width: number, options: MarkdownRenderOptions = {}): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const normalized = this.updateNormalizedValue(value);
    if (safeWidth !== this.width) {
      this.width = safeWidth;
      this.stablePrefix = "";
      this.stableLines = [];
    }

    this.scanStableLines(normalized);
    const nextStablePrefix = normalized.slice(0, this.stableEnd);
    if (nextStablePrefix !== this.stablePrefix) {
      this.stablePrefix = nextStablePrefix;
      this.stableLines = renderMarkdownInternal(this.stablePrefix, safeWidth, { streaming: false });
    }

    const tail = normalized.slice(this.stableEnd);
    if (!tail) return this.stableLines;
    const tailLines = renderMarkdownInternal(tail, safeWidth, options);
    if (this.stableLines[this.stableLines.length - 1] === "" && tailLines[0] === "") {
      return [...this.stableLines, ...tailLines.slice(1)];
    }
    return [...this.stableLines, ...tailLines];
  }

  private updateNormalizedValue(value: string): string {
    if (value === this.sourceValue) return this.normalizedValue;
    if (value.startsWith(this.sourceValue)) {
      const suffix = value.slice(this.sourceValue.length);
      let normalizedSuffix = normalizeMarkdown(suffix);
      if (this.sourceValue.endsWith("\r") && suffix.startsWith("\n")) normalizedSuffix = normalizedSuffix.slice(1);
      this.normalizedValue += normalizedSuffix;
      this.sourceValue = value;
      return this.normalizedValue;
    }

    this.sourceValue = value;
    this.normalizedValue = normalizeMarkdown(value);
    this.scanOffset = 0;
    this.scanFence = undefined;
    this.stableEnd = 0;
    this.stablePrefix = "";
    this.stableLines = [];
    return this.normalizedValue;
  }

  private scanStableLines(value: string): void {
    while (this.scanOffset < value.length) {
      const newline = value.indexOf("\n", this.scanOffset);
      if (newline < 0) return;
      const line = value.slice(this.scanOffset, newline).trimEnd();
      if (this.scanFence) {
        if (isFenceClose(line, this.scanFence)) {
          this.scanFence = undefined;
          // A fence block completes at its closing marker; commit the whole
          // block so it appears once closed instead of waiting for the next
          // blank line.
          this.stableEnd = newline + 1;
        }
      } else {
        this.scanFence = parseFenceOpen(line);
        if (!this.scanFence && !line.trim()) this.stableEnd = newline + 1;
      }
      this.scanOffset = newline + 1;
    }
  }
}

/**
 * Render both partial and completed Markdown through the same tolerant path.
 * This keeps streaming output from showing raw delimiters and then reflowing
 * into a different layout when the assistant turn is sealed.
 */
export function renderMarkdown(value: string, width: number, options: MarkdownRenderOptions = {}): string[] {
  return renderMarkdownInternal(normalizeMarkdown(value), Math.max(1, Math.floor(width)), options);
}

function renderMarkdownInternal(value: string, safeWidth: number, options: MarkdownRenderOptions): string[] {
  const lines: string[] = [];
  let fence: FenceState | undefined;
  const sourceLines = value.split("\n");

  for (let index = 0; index < sourceLines.length; index += 1) {
    const raw = sourceLines[index] ?? "";
    const line = raw.trimEnd();
    const isStreamingTail = Boolean(options.streaming && index === sourceLines.length - 1);

    if (fence) {
      if (isFenceClose(line, fence)) {
        fence = undefined;
        pushBlank(lines);
      } else if (isStreamingTail && isPartialFenceClose(line, fence)) {
        // A streamed closing fence often arrives one marker at a time. Hiding
        // the partial tail prevents a visible ` -> `` -> disappear sequence.
        continue;
      } else {
        lines.push(...renderCodeLine(line, safeWidth));
      }
      continue;
    }

    const openingFence = parseFenceOpen(line);
    if (openingFence) {
      pushBlank(lines);
      fence = openingFence;
      continue;
    }

    if (!line.trim()) {
      pushBlank(lines);
      continue;
    }

    // A streaming chunk may stop immediately after a block marker. Keep the
    // placeholder quiet until enough text arrives to render the actual block.
    if (isStreamingTail && isIncompleteBlockMarker(line)) {
      continue;
    }

    const setextLevel = parseSetextUnderline(sourceLines[index + 1]);
    if (setextLevel && !line.includes("|")) {
      pushBlank(lines);
      const color: InlineColor = setextLevel === 1 ? "orange" : "amber";
      lines.push(...wrapInlineSegments(withStyle(parseInline(line.trim(), false), { bold: true, color }), safeWidth));
      pushBlank(lines);
      index += 1;
      continue;
    }

    if (isTableStart(sourceLines, index)) {
      const rows = [parseTableRow(line)];
      const alignments = parseTableAlignments(sourceLines[index + 1] ?? "");
      index += 2;
      while (index < sourceLines.length && isTableRow(sourceLines[index] ?? "")) {
        rows.push(parseTableRow((sourceLines[index] ?? "").trimEnd()));
        index += 1;
      }
      index -= 1;
      pushBlank(lines);
      lines.push(
        ...renderTable(rows, safeWidth, Boolean(options.streaming && index >= sourceLines.length - 1), alignments),
      );
      pushBlank(lines);
      continue;
    }

    if (isHorizontalRule(line)) {
      pushBlank(lines);
      lines.push(`${ANSI.gray}${"─".repeat(Math.max(8, Math.min(safeWidth, 48)))}${ANSI.reset}`);
      pushBlank(lines);
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      pushBlank(lines);
      const color: InlineColor = heading.level <= 2 ? "orange" : "amber";
      lines.push(
        ...wrapInlineSegments(withStyle(parseInline(heading.body, isStreamingTail), { bold: true, color }), safeWidth),
      );
      pushBlank(lines);
      continue;
    }

    // eslint-disable-next-line no-control-regex -- 控制字符是刻意匹配的目标（ANSI 转义/文本清洗）
    const unordered = /^(\s*)[-*+][ \t]+(.+)$/.exec(line) ?? /^(\s*)[-*+](?=[^\x00-\x7f])(.+)$/.exec(line);
    if (unordered) {
      const indent = listIndent(unordered[1] ?? "");
      const bullet = `${"  ".repeat(indent)}${ANSI.orange}•${ANSI.reset} `;
      lines.push(
        ...renderPrefixed(
          parseInline(unordered[2] ?? "", isStreamingTail),
          bullet,
          " ".repeat(visibleWidth(bullet)),
          safeWidth,
        ),
      );
      continue;
    }

    // eslint-disable-next-line no-control-regex -- 控制字符是刻意匹配的目标（ANSI 转义/文本清洗）
    const ordered = /^(\s*)(\d+)[.)][ \t]+(.+)$/.exec(line) ?? /^(\s*)(\d+)[.)](?=[^\x00-\x7f])(.+)$/.exec(line);
    if (ordered) {
      const indent = "  ".repeat(listIndent(ordered[1] ?? ""));
      const prefix = `${indent}${ANSI.orange}${ordered[2]}.${ANSI.reset} `;
      lines.push(
        ...renderPrefixed(
          parseInline(ordered[3] ?? "", isStreamingTail),
          prefix,
          " ".repeat(visibleWidth(prefix)),
          safeWidth,
        ),
      );
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const prefix = `${ANSI.gray}│${ANSI.reset} `;
      lines.push(...renderPrefixed(parseInline(quote[1] ?? "", isStreamingTail), prefix, "  ", safeWidth));
      continue;
    }

    lines.push(...wrapInlineSegments(parseInline(line.trimStart(), isStreamingTail), safeWidth));
  }

  return lines;
}

function parseHeading(value: string): Heading | undefined {
  const standard = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(value);
  // eslint-disable-next-line no-control-regex -- 控制字符是刻意匹配的目标（ANSI 转义/文本清洗）
  const compactCjk = /^\s{0,3}(#{1,6})(?=[^\x00-\x7f])(.+?)\s*#*\s*$/.exec(value);
  const match = standard ?? compactCjk;
  if (!match) return undefined;
  return {
    level: match[1]?.length ?? 1,
    body: match[2] ?? "",
  };
}

function normalizeMarkdown(value: string): string {
  return stripTerminalMarkup(value).replace(/\r\n?/g, "\n");
}

function parseSetextUnderline(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^={2,}$/.test(trimmed)) return 1;
  if (/^-{2,}$/.test(trimmed)) return 2;
  return undefined;
}

function parseFenceOpen(value: string): FenceState | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})(?:\s*[^`]*)?$/.exec(value);
  const marker = match?.[1];
  if (!marker) return undefined;
  return {
    marker: marker[0] as FenceState["marker"],
    length: marker.length,
  };
}

function isFenceClose(value: string, fence: FenceState): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed[0] !== fence.marker) return false;
  return trimmed.length >= fence.length && Array.from(trimmed).every((character) => character === fence.marker);
}

function isPartialFenceClose(value: string, fence: FenceState): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length < fence.length &&
    Array.from(trimmed).every((character) => character === fence.marker)
  );
}

function isIncompleteBlockMarker(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^#{1,6}$/.test(trimmed) ||
    /^[-*+]$/.test(trimmed) ||
    /^\d+[.)]?$/.test(trimmed) ||
    /^-{1,2}$/.test(trimmed) ||
    /^~{1,2}$/.test(trimmed)
  );
}

function isHorizontalRule(value: string): boolean {
  const compact = value.trim().replace(/\s+/g, "");
  return /^-{3,}$/.test(compact) || /^\*{3,}$/.test(compact) || /^_{3,}$/.test(compact);
}

function isTableStart(lines: readonly string[], index: number): boolean {
  return isTableRow(lines[index] ?? "") && isTableDelimiter(lines[index + 1] ?? "");
}

function isTableRow(value: string): boolean {
  return value.includes("|") && parseTableRow(value).length > 1;
}

function isTableDelimiter(value: string): boolean {
  const cells = parseTableRow(value);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(value: string): string[] {
  const trimmed = value.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseTableAlignments(value: string): TableAlignment[] {
  return parseTableRow(value).map((cell) => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
    if (trimmed.endsWith(":")) return "right";
    return "left";
  });
}

function renderTable(
  rows: readonly string[][],
  width: number,
  streaming: boolean,
  alignments: readonly TableAlignment[],
): string[] {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const available = width - columnCount * 3 - 1;
  if (available < columnCount * 6) {
    return renderCompactTable(rows, width, streaming);
  }

  const naturalWidths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(3, ...rows.map((row) => visibleWidth(row[column] ?? ""))),
  );
  // Allot each column up to 40% of available width so long paths can breathe
  // instead of being chopped at 24 chars and wrapped mid-filename.
  const columnCap = Math.max(8, Math.floor(available * 0.4));
  const columnWidths = naturalWidths.map((item) => Math.min(columnCap, item));
  while (columnWidths.reduce((sum, item) => sum + item, 0) > available) {
    const largest = Math.max(...columnWidths);
    const index = columnWidths.findIndex((item) => item === largest && item > 3);
    if (index < 0) break;
    columnWidths[index] = Math.max(3, (columnWidths[index] ?? 3) - 1);
  }

  const output = [renderTableBorder(columnWidths, "┌", "┬", "┐")];
  output.push(...renderTableRow(rows[0] ?? [], columnWidths, true, streaming, alignments));
  output.push(renderTableBorder(columnWidths, "├", "┼", "┤"));
  for (const row of rows.slice(1)) output.push(...renderTableRow(row, columnWidths, false, streaming, alignments));
  output.push(renderTableBorder(columnWidths, "└", "┴", "┘"));
  return output;
}

function renderCompactTable(rows: readonly string[][], width: number, streaming: boolean): string[] {
  const headers = rows[0] ?? [];
  const records = rows.slice(1);
  if (records.length === 0) {
    return wrapInlineSegments(
      withStyle(parseInline(headers.join("  "), streaming), { bold: true, color: "orange" }),
      width,
    );
  }
  return records.flatMap((row, rowIndex) => {
    const lines = Array.from({ length: Math.max(headers.length, row.length) }, (_, column) => {
      const label = headers[column] || `Column ${column + 1}`;
      const segments = [
        ...withStyle(parseInline(label, streaming), { bold: true, color: "orange" }),
        { text: ": ", style: {} },
        ...parseInline(row[column] ?? "", streaming),
      ];
      return wrapInlineSegments(segments, width);
    }).flat();
    if (rowIndex < records.length - 1) lines.push("");
    return lines;
  });
}

function renderTableBorder(widths: readonly number[], left: string, middle: string, right: string): string {
  return `${ANSI.gray}${left}${widths.map((item) => "─".repeat(item + 2)).join(middle)}${right}${ANSI.reset}`;
}

function renderTableRow(
  row: readonly string[],
  widths: readonly number[],
  header: boolean,
  streaming: boolean,
  alignments: readonly TableAlignment[],
): string[] {
  const cells = widths.map((cellWidth, index) =>
    wrapInlineSegments(
      withStyle(parseInline(row[index] ?? "", streaming), header ? { bold: true, color: "orange" } : {}),
      cellWidth,
    ),
  );
  const height = Math.max(1, ...cells.map((cell) => cell.length));
  return Array.from({ length: height }, (_, lineIndex) => {
    const content = cells
      .map((cell, column) => {
        const item = cell[lineIndex] ?? "";
        return ` ${padTableCell(item, widths[column] ?? 1, alignments[column] ?? "left")} `;
      })
      .join(`${ANSI.gray}│${ANSI.reset}`);
    return `${ANSI.gray}│${ANSI.reset}${content}${ANSI.gray}│${ANSI.reset}`;
  });
}

function padTableCell(value: string, width: number, alignment: TableAlignment): string {
  const padding = Math.max(0, width - visibleWidth(value));
  if (alignment === "right") return `${" ".repeat(padding)}${value}`;
  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(padding - left)}`;
  }
  return `${value}${" ".repeat(padding)}`;
}

function parseInline(value: string, streaming: boolean, inherited: InlineStyle = {}): InlineSegment[] {
  const output: InlineSegment[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character === "\\" && index + 1 < value.length) {
      pushSegment(output, value[index + 1] ?? "", inherited);
      index += 2;
      continue;
    }

    const image = value.startsWith("![", index);
    if (image || character === "[") {
      const labelStart = index + (image ? 2 : 1);
      const labelEnd = value.indexOf("]", labelStart);
      if (labelEnd >= 0 && value[labelEnd + 1] === "(") {
        const targetEnd = value.indexOf(")", labelEnd + 2);
        if (targetEnd >= 0 || streaming) {
          if (image) pushSegment(output, "image: ", { ...inherited, color: "gray" });
          appendSegments(
            output,
            parseInline(value.slice(labelStart, labelEnd), streaming, {
              ...inherited,
              color: image ? "gray" : "orange",
              underline: !image,
            }),
          );
          index = targetEnd >= 0 ? targetEnd + 1 : value.length;
          continue;
        }
      }
      if (streaming) {
        const partialEnd = labelEnd >= 0 ? labelEnd : value.length;
        appendSegments(
          output,
          parseInline(value.slice(labelStart, partialEnd), true, {
            ...inherited,
            color: image ? "gray" : "orange",
            underline: !image,
          }),
        );
        index = labelEnd >= 0 ? labelEnd + 1 : value.length;
        continue;
      }
    }

    const marker = inlineMarkerAt(value, index);
    if (marker) {
      const close = value.indexOf(marker.text, index + marker.text.length);
      if (close >= 0) {
        appendSegments(
          output,
          parseInline(value.slice(index + marker.text.length, close), streaming, {
            ...inherited,
            ...marker.style,
          }),
        );
        index = close + marker.text.length;
        continue;
      }
      if (streaming) {
        appendSegments(
          output,
          parseInline(value.slice(index + marker.text.length), true, {
            ...inherited,
            ...marker.style,
          }),
        );
        break;
      }
    }

    pushSegment(output, character, inherited);
    index += 1;
  }
  return output;
}

function inlineMarkerAt(value: string, index: number): { text: string; style: InlineStyle } | undefined {
  if (value.startsWith("**", index) || value.startsWith("__", index)) {
    return { text: value.slice(index, index + 2), style: { bold: true } };
  }
  if (value.startsWith("~~", index)) return { text: "~~", style: { strike: true } };
  if (value[index] === "`") return { text: "`", style: { color: "amber" } };
  if (value[index] === "*" || value[index] === "_") {
    return { text: value[index] ?? "*", style: { italic: true } };
  }
  return undefined;
}

function renderPrefixed(
  content: readonly InlineSegment[],
  firstPrefix: string,
  continuationPrefix: string,
  width: number,
): string[] {
  const contentWidth = Math.max(1, width - Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix)));
  const wrapped = wrapInlineSegments(content, contentWidth);
  return wrapped.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
}

function wrapInlineSegments(segments: readonly InlineSegment[], width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  let units: InlineUnit[] = segments.flatMap((segment) =>
    graphemes(segment.text).map((text) => ({
      text,
      style: segment.style,
    })),
  );
  if (!units.length) return [""];
  const lines: string[] = [];

  while (units.length) {
    let used = 0;
    let fit = 0;
    while (fit < units.length) {
      const unitWidth = graphemeWidth(units[fit]?.text ?? "");
      if (fit > 0 && used + unitWidth > safeWidth) break;
      used += unitWidth;
      fit += 1;
    }
    if (fit >= units.length) {
      lines.push(renderInlineUnits(trimEndUnits(units)));
      break;
    }

    let split = fit;
    for (let index = fit - 1; index > 0; index -= 1) {
      if (/\s/u.test(units[index]?.text ?? "")) {
        split = index;
        break;
      }
    }
    const current = trimEndUnits(units.slice(0, split));
    lines.push(renderInlineUnits(current.length ? current : units.slice(0, fit)));
    units = units.slice(split > 0 ? split : fit);
    while (units.length && /\s/u.test(units[0]?.text ?? "")) units.shift();
  }
  return lines;
}

function trimEndUnits(units: readonly InlineUnit[]): InlineUnit[] {
  let end = units.length;
  while (end > 0 && /\s/u.test(units[end - 1]?.text ?? "")) end -= 1;
  return units.slice(0, end);
}

function renderInlineUnits(units: readonly InlineUnit[]): string {
  const segments: InlineSegment[] = [];
  for (const unit of units) pushSegment(segments, unit.text, unit.style);
  return segments.map((segment) => styleSegment(segment.text, segment.style)).join("");
}

function styleSegment(value: string, style: InlineStyle): string {
  const codes = [
    style.bold ? ANSI.bold : "",
    style.italic ? ANSI.italic : "",
    style.underline ? ANSI.underline : "",
    style.strike ? ANSI.strike : "",
    style.color === "amber"
      ? ANSI.amber
      : style.color === "orange"
        ? ANSI.orange
        : style.color === "gray"
          ? ANSI.gray
          : "",
  ].join("");
  return codes ? `${codes}${value}${ANSI.reset}` : value;
}

function withStyle(segments: readonly InlineSegment[], style: InlineStyle): InlineSegment[] {
  return segments.map((segment) => ({ text: segment.text, style: { ...segment.style, ...style } }));
}

function appendSegments(target: InlineSegment[], source: readonly InlineSegment[]): void {
  for (const segment of source) pushSegment(target, segment.text, segment.style);
}

function pushSegment(target: InlineSegment[], text: string, style: InlineStyle): void {
  if (!text) return;
  const previous = target[target.length - 1];
  if (previous && styleKey(previous.style) === styleKey(style)) previous.text += text;
  else target.push({ text, style });
}

function styleKey(style: InlineStyle): string {
  return `${style.bold ? 1 : 0}${style.italic ? 1 : 0}${style.strike ? 1 : 0}${style.underline ? 1 : 0}:${style.color ?? ""}`;
}

function renderCodeLine(value: string, width: number): string[] {
  const prefix = `${ANSI.gray}│${ANSI.reset} `;
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const expanded = value.replace(/\t/g, "  ");
  if (!expanded) return [prefix.trimEnd()];

  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const symbol of graphemes(expanded)) {
    const symbolWidth = graphemeWidth(symbol);
    if (current && currentWidth + symbolWidth > contentWidth) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += symbol;
    currentWidth += symbolWidth;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks.map((chunk) => `${prefix}${ANSI.dim}${chunk}${ANSI.reset}`);
}

function listIndent(value: string): number {
  return Math.min(6, Math.floor(value.replace(/\t/g, "  ").length / 2));
}

function pushBlank(lines: string[]): void {
  if (!lines.length || lines[lines.length - 1] === "") return;
  lines.push("");
}
