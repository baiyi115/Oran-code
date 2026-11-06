import { stripTerminalMarkup, truncateVisible, visibleWidth, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";

/** Unified hunks supply real line numbers; argument-only previews leave the gutter blank. */
export function renderDiff(value: string, width: number): string[] {
  const lines = stripTerminalMarkup(value).replace(/\r\n/g, "\n").trimEnd().split("\n");
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const output: string[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const gutterWidth = Math.min(7, Math.max(3, String(largestLineNumber(shown)).length));
  for (const line of shown) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      output.push(`${ANSI.gray}${truncateVisible(line, Math.max(1, width))}${ANSI.reset}`);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || !/^[ +-]/.test(line)) {
      if (line.startsWith("*** ") || line.startsWith("diff ")) oldLine = newLine = undefined;
      output.push(`${ANSI.gray}${truncateVisible(line, Math.max(1, width))}${ANSI.reset}`);
      continue;
    }
    const kind = line[0];
    const number = kind === "-" ? oldLine : newLine;
    const numberedGutter = `${number === undefined ? " ".repeat(gutterWidth) : String(number).padStart(gutterWidth)} ${kind} `;
    const gutter = visibleWidth(numberedGutter) < width - 1 ? numberedGutter : `${kind} `;
    const contentWidth = Math.max(1, width - visibleWidth(gutter));
    const color = kind === "+" ? ANSI.green : kind === "-" ? ANSI.red : "";
    const background = kind === "+" ? ANSI.additionBackground : kind === "-" ? ANSI.deletionBackground : "";
    wrapDisplayText(line.slice(1).replace(/\t/g, "    "), contentWidth).forEach((body, index) => {
      const row = `${index === 0 ? gutter : " ".repeat(visibleWidth(gutter))}${body}`;
      const padding = background ? " ".repeat(Math.max(0, width - visibleWidth(row))) : "";
      output.push(`${background}${color}${row}${padding}${ANSI.reset}`);
    });
    if (kind !== "+" && oldLine !== undefined) oldLine += 1;
    if (kind !== "-" && newLine !== undefined) newLine += 1;
  }
  if (shown.length < lines.length) {
    output.push(
      ...wrapDisplayText(`… ${lines.length - shown.length} lines hidden`, width).map(
        (line) => `${ANSI.gray}${line}${ANSI.reset}`,
      ),
    );
  }
  return output;
}

function largestLineNumber(lines: readonly string[]): number {
  let largest = lines.length;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk)
      largest = Math.max(largest, Number(hunk[1]) + Number(hunk[2] ?? 1), Number(hunk[3]) + Number(hunk[4] ?? 1));
  }
  return largest;
}

const MAX_RENDERED_LINES = 400;
