import { describe, expect, it } from "vitest";
import { collapseRepeatedLines, compactShellOutput, stripAnsi } from "../src/tools/output-pipeline.js";

describe("shell output pipeline", () => {
  it("strips ANSI color and cursor sequences", () => {
    const colored = "\u001b[31mred\u001b[0m text \u001b[1;32mgreen\u001b[0m";
    expect(stripAnsi(colored)).toBe("red text green");
    const cursor = "progress\u001b[2K\u001b[1Gdone";
    expect(stripAnsi(cursor)).toBe("progressdone");
  });

  it("collapses long runs of repeated lines and annotates the count", () => {
    const text = ["start", ...Array.from({ length: 5 }, () => "same line"), "end"].join("\n");
    expect(collapseRepeatedLines(text)).toBe(
      ["start", "same line", "[... line repeated 5 times ...]", "end"].join("\n"),
    );
  });

  it("keeps short repeats and blank lines untouched", () => {
    const text = ["a", "a", "", "", "", "", "b"].join("\n");
    expect(collapseRepeatedLines(text)).toBe(text);
  });

  it("combines both steps and trims trailing blank lines", () => {
    const raw = ["\u001b[32mok\u001b[0m", "ok", "ok", "ok", "", ""].join("\n");
    // 去 ANSI 后第一行与后续三行相同,共四次重复,折叠为一行并标注次数。
    expect(compactShellOutput(raw)).toBe(["ok", "[... line repeated 4 times ...]"].join("\n"));
  });

  it("passes short output through unchanged", () => {
    expect(compactShellOutput("exit 0\n")).toBe("exit 0");
    expect(compactShellOutput("")).toBe("");
  });
});
