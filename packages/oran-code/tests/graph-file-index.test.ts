import { describe, expect, it } from "vitest";
import { fileIndexFor } from "../src/graph/languages/file-index.js";

/**
 * The index replaced per-specifier scans of the whole file set, so the lookups must return exactly
 * what `[...fileSet].filter(...).sort()` returned — including the order, which decides which path
 * the graph reports, and the case sensitivity of the extension filter.
 */
const FILES: ReadonlySet<string> = new Set([
  "src/a.ts",
  "src/b.ts",
  "src/nested/c.ts",
  "src/z.go",
  "src/X.GO",
  "lib/util.rb",
  "lib/a/util.rb",
  "README.md",
]);

describe("graph file index", () => {
  const index = fileIndexFor(FILES);

  it("lists the direct children of one directory, optionally by extension", () => {
    expect(index.containedIn("src")).toEqual(["src/X.GO", "src/a.ts", "src/b.ts", "src/z.go"]);
    expect(index.containedIn("src", ".ts")).toEqual(["src/a.ts", "src/b.ts"]);
    // Extensions are matched as written: a scan for `.go` never matched `X.GO` and still does not.
    expect(index.containedIn("src", ".go")).toEqual(["src/z.go"]);
    expect(index.containedIn(".")).toEqual(["README.md"]);
    expect(index.containedIn("missing")).toEqual([]);
  });

  it("lists files under a prefix", () => {
    expect(index.withPrefix("src/", ".ts")).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
    expect(index.withPrefix("src/")).toEqual(["src/X.GO", "src/a.ts", "src/b.ts", "src/nested/c.ts", "src/z.go"]);
    expect(index.withPrefix("lib/")).toEqual(["lib/a/util.rb", "lib/util.rb"]);
    expect(index.withPrefix("nowhere/")).toEqual([]);
    expect(index.hasPrefix("src/")).toBe(true);
    expect(index.hasPrefix("src/z")).toBe(true);
    expect(index.hasPrefix("srcz")).toBe(false);
  });

  it("matches a suffix at any depth", () => {
    expect(index.withSuffix("util.rb")).toEqual(["lib/a/util.rb", "lib/util.rb"]);
    expect(index.withSuffix("lib/a/util.rb")).toEqual(["lib/a/util.rb"]);
    expect(index.withSuffix("missing.rb")).toEqual([]);
  });

  it("is built once per file set", () => {
    expect(fileIndexFor(FILES)).toBe(index);
    const other: ReadonlySet<string> = new Set(["only.ts"]);
    expect(fileIndexFor(other)).not.toBe(index);
    expect(fileIndexFor(other).containedIn(".")).toEqual(["only.ts"]);
  });
});
