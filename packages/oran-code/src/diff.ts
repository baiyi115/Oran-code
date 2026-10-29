/**
 * Unified diff generation for the transcript's file-change preview.
 *
 * A file-writing tool reports the diff it actually applied through its result metadata, so the UI
 * shows what changed on disk. Deriving that from the tool arguments cannot work for a whole-file
 * write: the previous content is not among the arguments, so every line of an overwrite would read
 * as an addition.
 *
 * Display only — nothing here feeds the model. The output is bounded (hunk context, a body-line
 * budget) because it travels through tool metadata, the trace, and the session archive.
 */

export interface FileDiff {
  /** Unified diff text with `@@` hunk headers; empty when the change is too large to show. */
  text: string;
  /** Changed lines in the whole file, not just the emitted (possibly truncated) text. */
  added: number;
  removed: number;
  /** True when `text` stops before the end of the change. */
  truncated: boolean;
}

export interface FileDiffOptions {
  /** Unchanged lines kept on each side of a change. Default 3. */
  context?: number;
  /** Upper bound on emitted diff body lines. Default 400. */
  maxBodyLines?: number;
}

/** A middle section larger than this skips the LCS table and reports a full replacement. */
const MAX_LCS_LINES = 800;

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_BODY_LINES = 400;

type RowType = "equal" | "add" | "remove";

interface ChangeBlock {
  readonly type: RowType;
  readonly lines: readonly string[];
}

interface DiffRow {
  readonly type: RowType;
  readonly text: string;
  /** 1-based line in the old file; for an insertion, the line it follows. */
  readonly oldLine: number;
  /** 1-based line in the new file; for a deletion, the line it follows. */
  readonly newLine: number;
}

/** Undefined when nothing changed (or only line endings did). */
export function createFileDiff(before: string, after: string, options: FileDiffOptions = {}): FileDiff | undefined {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  // Unchanged head and tail never take part in the diff; trimming them first keeps the LCS table
  // proportional to the edit rather than to the file.
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middle = diffMiddle(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
  );
  if (!middle.length) return undefined;

  const blocks: ChangeBlock[] = [];
  if (prefix > 0) blocks.push({ type: "equal", lines: oldLines.slice(0, prefix) });
  blocks.push(...middle);
  if (suffix > 0) blocks.push({ type: "equal", lines: oldLines.slice(oldLines.length - suffix) });

  const rows = toRows(blocks);
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === "add") added += 1;
    else if (row.type === "remove") removed += 1;
  }
  const hunks = renderHunks(rows, options.context ?? DEFAULT_CONTEXT, options.maxBodyLines ?? DEFAULT_MAX_BODY_LINES);
  return { text: hunks.text, added, removed, truncated: hunks.truncated };
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // The final newline is not a line: keeping it would show a phantom empty line at the end of
  // every whole-file write.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest-common-subsequence edit script for the changed region.
 *
 * Line-level LCS, so a moved or rewritten block is reported as the smallest set of changed lines
 * rather than "everything after the first difference". Sections too large for the table degrade to
 * a full replacement, which is truthful but not minimal.
 */
function diffMiddle(oldLines: readonly string[], newLines: readonly string[]): ChangeBlock[] {
  if (!oldLines.length) return newLines.length ? [{ type: "add", lines: [...newLines] }] : [];
  if (!newLines.length) return [{ type: "remove", lines: [...oldLines] }];
  if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
    return [
      { type: "remove", lines: [...oldLines] },
      { type: "add", lines: [...newLines] },
    ];
  }

  const rows = oldLines.length;
  const columns = newLines.length + 1;
  // table[i * columns + j] = LCS length of oldLines[i..] and newLines[j..]
  const table = new Uint32Array((rows + 1) * columns);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * columns + j + 1]! + 1
          : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
    }
  }

  const blocks: ChangeBlock[] = [];
  const current: string[] = [];
  let currentType: RowType | undefined;
  const push = (type: RowType, line: string): void => {
    if (type !== currentType && current.length) blocks.push({ type: currentType!, lines: current.splice(0) });
    currentType = type;
    current.push(line);
  };
  let i = 0;
  let j = 0;
  while (i < rows && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      push("equal", oldLines[i]!);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) {
      push("remove", oldLines[i]!);
      i += 1;
    } else {
      push("add", newLines[j]!);
      j += 1;
    }
  }
  while (i < rows) {
    push("remove", oldLines[i]!);
    i += 1;
  }
  while (j < newLines.length) {
    push("add", newLines[j]!);
    j += 1;
  }
  if (current.length) blocks.push({ type: currentType!, lines: current.splice(0) });
  return blocks;
}

function toRows(blocks: readonly ChangeBlock[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const block of blocks) {
    for (const text of block.lines) {
      if (block.type === "equal") {
        rows.push({ type: "equal", text, oldLine: oldLine + 1, newLine: newLine + 1 });
        oldLine += 1;
        newLine += 1;
      } else if (block.type === "remove") {
        rows.push({ type: "remove", text, oldLine: oldLine + 1, newLine });
        oldLine += 1;
      } else {
        rows.push({ type: "add", text, oldLine, newLine: newLine + 1 });
        newLine += 1;
      }
    }
  }
  return rows;
}

function renderHunks(rows: readonly DiffRow[], context: number, maxBodyLines: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  let budget = maxBodyLines;
  let truncated = false;
  let index = 0;
  while (index < rows.length) {
    while (index < rows.length && rows[index]!.type === "equal") index += 1;
    if (index >= rows.length) break;
    const first = index;
    // One hunk covers every change separated by at most 2×context unchanged lines; anything wider
    // apart opens a new hunk so the reader keeps a position marker.
    let last = index;
    let probe = index;
    while (probe < rows.length) {
      if (rows[probe]!.type !== "equal") {
        last = probe;
        probe += 1;
        continue;
      }
      let end = probe;
      while (end < rows.length && rows[end]!.type === "equal") end += 1;
      if (end >= rows.length || end - probe > context * 2) break;
      probe = end;
    }
    const start = Math.max(0, first - context);
    const end = Math.min(rows.length, last + 1 + context);
    index = end;

    if (budget <= 0) {
      truncated = true;
      break;
    }
    const slice = rows.slice(start, end);
    const oldCount = slice.filter((row) => row.type !== "add").length;
    const newCount = slice.filter((row) => row.type !== "remove").length;
    out.push(`@@ -${slice[0]!.oldLine},${oldCount} +${slice[0]!.newLine},${newCount} @@`);
    for (const row of slice) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      out.push(`${rowPrefix(row.type)}${row.text}`);
      budget -= 1;
    }
    if (truncated) break;
  }
  if (truncated) out.push("… diff truncated");
  return { text: out.join("\n"), truncated };
}

function rowPrefix(type: RowType): string {
  if (type === "add") return "+";
  if (type === "remove") return "-";
  return " ";
}
