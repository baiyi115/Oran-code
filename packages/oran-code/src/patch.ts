/**
 * Unified diff parsing and application.
 *
 * Accepts standard unified diff hunks:
 *
 *   @@ -start,count +start,count @@ optional heading
 *    context lines start with a space
 *   -removed lines start with '-'
 *   +added lines start with '+'
 *
 * File header lines (index / --- / +++ / diff --git) before the first hunk are
 * ignored; the target path is supplied by the caller. Hunk line numbers may be
 * approximate: every hunk is located by matching its context/removal lines
 * against the file, with a bounded search window around the declared position.
 */

export interface UnifiedDiffHunkLine {
  readonly type: "context" | "remove" | "add";
  readonly text: string;
}

export interface UnifiedDiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly UnifiedDiffHunkLine[];
}

export interface PatchApplyResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
  readonly hunksApplied: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const NO_NEWLINE = /^\\\s*No newline (?:at|before) end of file$/i;
const MAX_SEARCH_WINDOW = 200;

export function parseUnifiedDiff(diff: string): { ok: true; hunks: UnifiedDiffHunk[] } | { ok: false; error: string } {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks: UnifiedDiffHunk[] = [];
  let index = 0;

  // Skip file header lines up to the first hunk header.
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (HUNK_HEADER.test(line)) break;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    // Only recognize header shapes; anything else before the first hunk is a parse error.
    if (!/^(?:index |diff --git |--- |\+\+\+ )/.test(line)) {
      return { ok: false, error: `unexpected line before first hunk: ${truncate(line)}` };
    }
    index += 1;
  }

  while (index < lines.length) {
    const header = lines[index];
    if (header === undefined || header.trim() === "") {
      index += 1;
      continue;
    }
    const match = HUNK_HEADER.exec(header);
    if (!match) {
      if (NO_NEWLINE.test(header)) {
        index += 1;
        continue;
      }
      return { ok: false, error: `malformed hunk header: ${truncate(header)}` };
    }
    const oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    index += 1;

    const hunkLines: UnifiedDiffHunkLine[] = [];
    let parsedAny = false;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line === "") {
        // Trailing/embedded blank lines from a diff that ends with a newline
        // are not hunk content; skip them.
        index += 1;
        continue;
      }
      if (line.startsWith("@@")) break;
      if (NO_NEWLINE.test(line)) {
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        hunkLines.push({ type: "context", text: line.slice(1) });
        parsedAny = true;
        index += 1;
        continue;
      }
      // Header lines (---/+++ paths) only appear before the first hunk and were
      // consumed above. A second header inside a hunk means a multi-file diff,
      // which apply_patch does not support.
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff --git ")) {
        return { ok: false, error: "multi-file diffs are not supported; apply one diff per file" };
      }
      // Inside a hunk body a leading '-' or '+' is always content markup, even
      // when the content itself starts with '-' or '+'.
      if (line.startsWith("-")) {
        hunkLines.push({ type: "remove", text: line.slice(1) });
        parsedAny = true;
        index += 1;
        continue;
      }
      if (line.startsWith("+")) {
        hunkLines.push({ type: "add", text: line.slice(1) });
        parsedAny = true;
        index += 1;
        continue;
      }
      return { ok: false, error: `malformed hunk body line: ${truncate(line)}` };
    }
    if (!parsedAny) return { ok: false, error: "hunk with no body lines" };
    hunks.push({ oldStart, newStart, lines: hunkLines });
  }

  if (!hunks.length) return { ok: false, error: "diff contains no @@ hunks" };
  return { ok: true, hunks };
}

export function applyUnifiedDiff(content: string, diff: string): PatchApplyResult {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return { ok: false, error: parsed.error, hunksApplied: 0, linesAdded: 0, linesRemoved: 0 };

  const isCrlf = content.includes("\r\n");
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lines = normalizedContent.split("\n");
  let delta = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const hunk of parsed.hunks) {
    const probe = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);
    // Insert-only hunks (no context/removal lines) position at oldStart in
    // 0-based terms; hunks with content anchor at oldStart - 1 plus the net
    // offset contributed by previously applied hunks.
    const declared = (probe.length ? hunk.oldStart - 1 : hunk.oldStart) + delta;
    const match = findMatch(lines, probe, declared);
    if (match === undefined) {
      return {
        ok: false,
        error: `hunk at @@ -${hunk.oldStart} +${hunk.newStart} @@ did not match the file content; provide context lines that exist verbatim`,
        hunksApplied: 0,
        linesAdded: 0,
        linesRemoved: 0,
      };
    }

    const output: string[] = [];
    let cursor = match;
    for (const entry of hunk.lines) {
      if (entry.type === "add") {
        output.push(entry.text);
        linesAdded += 1;
        continue;
      }
      if (cursor >= lines.length) {
        return { ok: false, error: "hunk extends beyond the end of the file", hunksApplied: 0, linesAdded: 0, linesRemoved: 0 };
      }
      if (entry.type === "context") output.push(lines[cursor] ?? "");
      else linesRemoved += 1;
      cursor += 1;
    }
    lines.splice(match, cursor - match, ...output);
    delta += output.length - (cursor - match);
  }

  const resultText = lines.join("\n");
  const finalContent = isCrlf ? resultText.replace(/\n/g, "\r\n") : resultText;
  return { ok: true, content: finalContent, hunksApplied: parsed.hunks.length, linesAdded, linesRemoved };
}

/** Locate a hunk by matching its context/removal lines around the declared position. */
function findMatch(lines: readonly string[], probe: readonly string[], declared: number): number | undefined {
  if (!probe.length) return clamp(declared, 0, lines.length);

  // Pass 1: Exact match in local window around declared position.
  const lo = Math.max(0, declared - MAX_SEARCH_WINDOW);
  const hi = Math.min(lines.length - probe.length, declared + MAX_SEARCH_WINDOW);
  for (let position = lo; position <= hi; position += 1) {
    if (matchesAt(lines, probe, position, (a, b) => a === b)) return position;
  }

  // Pass 2: Exact match across entire file.
  const totalHi = lines.length - probe.length;
  for (let position = 0; position <= totalHi; position += 1) {
    if (matchesAt(lines, probe, position, (a, b) => a === b)) return position;
  }

  // Pass 3: Trailing-whitespace-tolerant match in local window.
  for (let position = lo; position <= hi; position += 1) {
    if (matchesAt(lines, probe, position, (a, b) => a.trimEnd() === b.trimEnd())) return position;
  }

  // Pass 4: Trailing-whitespace-tolerant match across entire file.
  for (let position = 0; position <= totalHi; position += 1) {
    if (matchesAt(lines, probe, position, (a, b) => a.trimEnd() === b.trimEnd())) return position;
  }

  // Pass 5: Full trim (indentation-tolerant) match across file if unique or closest to declared.
  const trimMatches: number[] = [];
  for (let position = 0; position <= totalHi; position += 1) {
    if (matchesAt(lines, probe, position, (a, b) => a.trim() === b.trim())) {
      trimMatches.push(position);
    }
  }
  if (trimMatches.length === 1) return trimMatches[0];
  if (trimMatches.length > 1) {
    trimMatches.sort((a, b) => Math.abs(a - declared) - Math.abs(b - declared));
    return trimMatches[0];
  }
  return undefined;
}

function matchesAt(
  lines: readonly string[],
  probe: readonly string[],
  position: number,
  comparator: (a: string, b: string) => boolean,
): boolean {
  for (let offset = 0; offset < probe.length; offset += 1) {
    if (!comparator(lines[position + offset] ?? "", probe[offset] ?? "")) {
      return false;
    }
  }
  return true;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}
