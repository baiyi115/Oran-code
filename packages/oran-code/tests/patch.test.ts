import { describe, expect, it } from "vitest";
import { applyUnifiedDiff, parseUnifiedDiff } from "../src/patch.js";

const SAMPLE = [
  "line one",
  "line two",
  "line three",
  "line four",
  "line five",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses a simple hunk", () => {
    const diff = [
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,2 @@",
      " line one",
      "-line two",
      "+line TWO",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.hunks).toHaveLength(1);
      expect(parsed.hunks[0]?.lines).toEqual([
        { type: "context", text: "line one" },
        { type: "remove", text: "line two" },
        { type: "add", text: "line TWO" },
      ]);
    }
  });

  it("accepts hunks without comma counts", () => {
    const parsed = parseUnifiedDiff("@@ -2 +2 @@\n-line two\n+line TWO\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.hunks[0]?.oldStart).toBe(2);
  });

  it("rejects a diff without hunks", () => {
    const parsed = parseUnifiedDiff("--- a/file\n+++ b/file\n");
    expect(parsed.ok).toBe(false);
  });

  it("rejects malformed hunk bodies", () => {
    const parsed = parseUnifiedDiff("@@ -1,1 +1,1 @@\nnot a diff line\n");
    expect(parsed.ok).toBe(false);
  });
});

describe("applyUnifiedDiff", () => {
  it("replaces one line", () => {
    const diff = "@@ -2,1 +2,1 @@\n-line two\n+line TWO\n";
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(SAMPLE.replace("line two", "line TWO"));
    expect(result.hunksApplied).toBe(1);
  });

  it("applies multiple hunks in order", () => {
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-line one",
      "+line ONE",
      "@@ -5,1 +5,1 @@",
      "-line five",
      "+line FIVE",
    ].join("\n");
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(["line ONE", "line two", "line three", "line four", "line FIVE"].join("\n"));
    expect(result.hunksApplied).toBe(2);
  });

  it("adds and removes lines together", () => {
    const diff = [
      "@@ -2,2 +2,3 @@",
      "-line two",
      "-line three",
      "+line 2",
      "+line 3",
      "+line 3.5",
    ].join("\n");
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(["line one", "line 2", "line 3", "line 3.5", "line four", "line five"].join("\n"));
    expect(result.linesAdded).toBe(3);
    expect(result.linesRemoved).toBe(2);
  });

  it("appends lines with an insert-only hunk", () => {
    const diff = "@@ -5,0 +6,1 @@\n+line six\n";
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(`${SAMPLE}\nline six`);
  });

  it("appends lines with a git-style context hunk", () => {
    // git emits the line before the insertion as context: @@ -5,0 +6 @@ line five
    const diff = "@@ -5,0 +6 @@ line five\n line five\n+line six\n";
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(`${SAMPLE}\nline six`);
  });

  it("locates a hunk by context even when line numbers are wrong", () => {
    // Declared at line 100, but the context actually lives at line 3.
    const diff = "@@ -100,3 +100,3 @@\n line three\n-line four\n+line FOUR\n";
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(["line one", "line two", "line three", "line FOUR", "line five"].join("\n"));
  });

  it("fails when context lines do not exist in the file", () => {
    const diff = "@@ -1,2 +1,2 @@\n no such line\n-anything\n+changed\n";
    const result = applyUnifiedDiff(SAMPLE, diff);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not match");
  });

  it("keeps trailing newline handling simple and lossless", () => {
    const content = "a\nb\nc\n";
    const diff = "@@ -2,1 +2,1 @@\n-b\n+B\n";
    const result = applyUnifiedDiff(content, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("a\nB\nc\n");
  });

  it("handles removed lines whose content starts with dashes", () => {
    const content = "--old\nplain\n";
    const diff = "@@ -1,1 +1,1 @@\n---old\n+--new\n";
    const result = applyUnifiedDiff(content, diff);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("--new\nplain\n");
  });

  it("rejects multi-file diffs", () => {
    const diff = [
      "diff --git a/x.txt b/x.txt",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+A",
      "diff --git a/y.txt b/y.txt",
      "@@ -1,1 +1,1 @@",
      "-b",
      "+B",
    ].join("\n");
    const result = applyUnifiedDiff("a\nb\n", diff);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("multi-file diffs are not supported");
  });
});
