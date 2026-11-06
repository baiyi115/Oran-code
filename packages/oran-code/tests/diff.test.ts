import { describe, expect, it } from "vitest";
import { createFileDiff } from "../src/diff.js";

describe("createFileDiff", () => {
  it("reports nothing when the text is unchanged", () => {
    expect(createFileDiff("a\nb\n", "a\nb\n")).toBeUndefined();
    // A line-ending change alone is not a content change.
    expect(createFileDiff("a\r\nb\r\n", "a\nb\n")).toBeUndefined();
  });

  it("shows a modification with context and the real counts", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "2", "3", "4", "changed", "6", "7", "8"].join("\n");
    const diff = createFileDiff(before, after);
    expect(diff).toBeDefined();
    expect(diff).toMatchObject({ added: 1, removed: 1, truncated: false });
    expect(diff!.text.split("\n")).toEqual(["@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+changed", " 6", " 7", " 8"]);
  });

  it("reports a new file as pure additions", () => {
    const diff = createFileDiff("", "one\ntwo\n");
    expect(diff).toMatchObject({ added: 2, removed: 0 });
    expect(diff!.text.split("\n")).toEqual(["@@ -0,0 +1,2 @@", "+one", "+two"]);
  });

  it("splits changes that are farther apart than the context window", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const lines = before.split("\n");
    lines[1] = "first change";
    lines[18] = "second change";
    const diff = createFileDiff(before, lines.join("\n"));
    expect(diff!.text.match(/^@@ /gm)).toHaveLength(2);
  });

  it("keeps the counts and marks the text when the diff is larger than the budget", () => {
    const before = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const after = Array.from({ length: 200 }, (_, index) => `rewritten ${index}`).join("\n");
    const diff = createFileDiff(before, after, { maxBodyLines: 10 });
    expect(diff).toMatchObject({ added: 200, removed: 200, truncated: true });
    expect(diff!.text.endsWith("… diff truncated")).toBe(true);
    expect(diff!.text.split("\n").length).toBeLessThanOrEqual(13);
  });

  it("degrades to a full replacement when the changed middle is too large for the table", () => {
    const before = Array.from({ length: 900 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 900 }, (_, index) => `b${index}`).join("\n");
    const diff = createFileDiff(before, after, { maxBodyLines: 5 });
    expect(diff).toMatchObject({ added: 900, removed: 900 });
  });
});
