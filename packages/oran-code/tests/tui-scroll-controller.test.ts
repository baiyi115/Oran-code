import { describe, expect, it } from "vitest";
import { scrollPercent, scrollTranscript, syncTranscriptScroll } from "../src/tui/scroll-controller.js";
import type { TranscriptScrollState } from "../src/tui/types.js";

function state(overrides: Partial<TranscriptScrollState> = {}): TranscriptScrollState {
  return { offsetFromBottom: 0, followBottom: true, ...overrides };
}

describe("TUI transcript scrolling", () => {
  it("follows the bottom until the user scrolls away", () => {
    const scroll = state();
    syncTranscriptScroll(scroll, 20, 5, 10);
    expect(scroll).toMatchObject({ offsetFromBottom: 0, followBottom: true });

    scrollTranscript(scroll, 3, 15);
    expect(scroll).toMatchObject({ offsetFromBottom: 3, followBottom: false });
    syncTranscriptScroll(scroll, 24, 5, 20);
    expect(scroll).toMatchObject({ offsetFromBottom: 7, followBottom: false });
  });

  it("clamps offsets at both ends and reports the correct percentage", () => {
    const scroll = state({ offsetFromBottom: 99, followBottom: false });
    scrollTranscript(scroll, 1, 4);
    expect(scroll.offsetFromBottom).toBe(4);
    scrollTranscript(scroll, -99, 4);
    expect(scroll).toMatchObject({ offsetFromBottom: 0, followBottom: true });
    expect(scrollPercent(0, 10, 4)).toBe(100);
    expect(scrollPercent(3, 10, 4)).toBeCloseTo(50);
    expect(scrollPercent(99, 10, 4)).toBe(0);
  });

  it("does not apply append compensation when a message anchor is active", () => {
    const scroll = state({
      offsetFromBottom: 4,
      followBottom: false,
      anchor: { messageId: "message-2", lineOffset: 1 },
    });
    syncTranscriptScroll(scroll, 30, 8, 20);
    expect(scroll.offsetFromBottom).toBe(4);
  });
});
