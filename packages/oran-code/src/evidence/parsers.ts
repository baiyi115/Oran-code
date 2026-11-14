import { stripVTControlCharacters } from "node:util";
import type { TestSummary } from "./types.js";

export interface ParsedSummary {
  parserKind: string;
  summary: TestSummary;
  limitations: string[];
}

/** Parse summaries as diagnostic data, never as an independent execution verdict. */
export function parseTestSummary(text: string): ParsedSummary {
  const output = stripVTControlCharacters(text);
  let node: TestSummary | undefined;
  let nodeKind = "unknown";
  for (const match of output.matchAll(
    /^[ \t]*(ℹ|#)[ \t]+(tests|pass|fail|skipped|cancelled|todo)[ \t]+(\d+)[ \t]*\r?$/gm,
  )) {
    const key = match[2]!;
    const value = Number(match[3]);
    if (key === "tests") {
      node = { total: value };
      nodeKind = match[1] === "#" ? "node-tap" : "node-spec";
    } else if (node) {
      if (key === "pass") node.passed = value;
      if (key === "fail") node.failed = value;
      if (key === "skipped") node.skipped = value;
      if (key === "cancelled") node.cancelled = value;
    }
  }
  if (node?.passed !== undefined && node.failed !== undefined && node.total !== undefined) {
    const valid = Object.values(node).every(Number.isSafeInteger) && node.passed + node.failed <= node.total;
    return {
      parserKind: valid ? nodeKind : "unknown",
      summary: valid ? node : {},
      limitations: valid ? ["text_summary_not_authenticated"] : ["inconsistent_test_counts"],
    };
  }
  const labelled = [...output.matchAll(/^[ \t]*Tests:?[ \t]+([^\r\n]*)/gm)].at(-1);
  const source = labelled?.[1] ?? output.replace(/^[ \t]*Test (?:Files|Suites):?[ \t].*$/gim, "");
  const summary: TestSummary = {};
  const fields = {
    passed: /(?:passed|passing)/,
    failed: /(?:failed|failing)/,
    skipped: /(?:skipped|pending)/,
    cancelled: /cancelled/,
  } as const;
  for (const [key, suffix] of Object.entries(fields)) {
    const match = new RegExp(`(\\d+)\\s+${suffix.source}\\b`, "i").exec(source);
    if (match) summary[key as keyof TestSummary] = Number(match[1]);
  }
  const total = /(\d+)\s+total\b/i.exec(source)?.[1] ?? (labelled ? /\((\d+)\)/.exec(source)?.[1] : undefined);
  if (total !== undefined) summary.total = Number(total);
  if (!Object.keys(summary).length)
    return { parserKind: "unknown", summary: {}, limitations: ["unrecognized_test_summary"] };
  if (Object.values(summary).some((n) => !Number.isSafeInteger(n))) {
    return { parserKind: "unknown", summary: {}, limitations: ["invalid_test_counts"] };
  }
  // Absence stays unknown: a positive pass count does not imply zero failures.
  const parserKind = labelled
    ? labelled[0].trimStart().startsWith("Tests:")
      ? "jest"
      : "vitest"
    : /\bpytest\b|\bin \d+(?:\.\d+)?s\b/.test(source)
      ? "pytest-summary"
      : /\d+\s+passing\s*\([^)]+\)/i.test(source)
        ? "mocha-summary"
        : "text-summary";
  return { parserKind, summary, limitations: ["text_summary_not_authenticated"] };
}
