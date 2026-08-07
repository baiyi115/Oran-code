import type { Widgets } from "blessed";
import { describe, expect, it, vi } from "vitest";
import { calculateLayoutRows, formatStatusLine, renderWithStableCursor, transcriptViewportLines, visibleOverlayLines } from "../src/tui/layout.js";
import { horizontalRule, lineStyle, textStyle } from "../src/tui/theme.js";
import { createTuiState } from "../src/tui/state.js";

describe("transparent TUI theme", () => {
  it("uses the terminal default background without Blessed color blending", () => {
    expect(textStyle()).toMatchObject({ fg: "default", bg: "default" });
    expect(lineStyle()).toMatchObject({ fg: "default", bg: "default" });
    expect(textStyle()).not.toHaveProperty("transparent");
    expect(lineStyle()).not.toHaveProperty("transparent");
    expect(horizontalRule(8)).toBe("────────");
    expect(horizontalRule(0)).toBe("─");
  });

  it("keeps the two-line footer bounded and readable", () => {
    const state = createTuiState("D:\\Programming\\project\\LiteAgent", "demo/model");
    expect(formatStatusLine(state, 120).split("\n")).toEqual([
      "auto · medium · demo/model · Context: --",
      "D:\\Programming\\project\\LiteAgent",
    ]);
    const compactFooter = formatStatusLine(state, 48).split("\n");
    expect(compactFooter).toHaveLength(2);
    expect(compactFooter[0]).toContain("auto · medium");
    expect(compactFooter[1]).toContain("D:\\Programming");
    expect(compactFooter.every((line) => line.length <= 48)).toBe(true);
    for (const width of [1, 2, 3]) {
      expect(formatStatusLine(state, width).split("\n").every((line) => line.length <= width)).toBe(true);
    }
  });

  it("leaves cursor shape ownership to the host terminal", () => {
    const render = vi.fn();
    const hideCursor = vi.fn();
    const flush = vi.fn();
    const write = vi.fn();
    const screen = {
      render,
      program: { cursorHidden: true, hideCursor, flush, output: { write } },
    } as unknown as Widgets.Screen;

    renderWithStableCursor(screen, { row: 21, column: 3 });

    expect(render).toHaveBeenCalledOnce();
    expect(hideCursor).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("\x1b[22;4H\x1b[?25h");
    expect(write.mock.calls.flat().join(" ")).not.toContain("\x1b[1 q");
    expect(hideCursor.mock.invocationCallOrder[0]).toBeLessThan(render.mock.invocationCallOrder[0] ?? 0);
    expect(render.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0] ?? 0);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0] ?? 0);
  });

  it("keeps the native cursor hidden while an overlay owns input", () => {
    const write = vi.fn();
    const screen = {
      render: vi.fn(),
      program: { cursorHidden: true, hideCursor: vi.fn(), flush: vi.fn(), output: { write } },
    } as unknown as Widgets.Screen;

    renderWithStableCursor(screen);

    expect(write).toHaveBeenCalledWith("\x1b[?25l");
  });

  it("keeps the selected overlay row visible", () => {
    const lines = ["0", "1", "2", "3", "4", "5"];
    expect(visibleOverlayLines(lines, 3, 1)).toEqual(["0", "1", "2"]);
    expect(visibleOverlayLines(lines, 3, 4)).toEqual(["2", "3", "4"]);
    expect(visibleOverlayLines(lines, 3, 5)).toEqual(["3", "4", "5"]);
  });

  it("renders the selected transcript window without relying on Blessed scroll state", () => {
    const lines = ["old 1", "old 2", "old 3", "new 1", "new 2"];

    expect(transcriptViewportLines(lines, 2, 0)).toEqual(["new 1", "new 2"]);
    expect(transcriptViewportLines(lines, 2, 2)).toEqual(["old 2", "old 3"]);
    expect(transcriptViewportLines([...lines, "new 3"], 2, 2)).toEqual(["old 3", "new 1"]);
    expect(transcriptViewportLines(lines, 20, 0)).toEqual(lines);
  });

  it("uses valid rows and reserves a two-line footer", () => {
    expect(calculateLayoutRows(24)).toEqual({
      viewportTop: 0,
      viewportHeight: 19,
      inputTop: 19,
      inputRow: 20,
      inputBottom: 21,
      statusTop: 22,
      statusHeight: 2,
    });
    const compact = calculateLayoutRows(7);
    expect(compact.viewportHeight).toBe(2);
    expect(compact.inputTop).toBe(2);
    expect(compact.inputTop).toBeLessThanOrEqual(compact.inputRow);
    expect(compact.inputRow).toBeLessThanOrEqual(compact.inputBottom);
    expect(compact.inputBottom).toBeLessThan(compact.statusTop);
    expect(compact.statusTop).toBeLessThan(7);
    expect(compact.statusHeight).toBeGreaterThan(0);
  });
});
