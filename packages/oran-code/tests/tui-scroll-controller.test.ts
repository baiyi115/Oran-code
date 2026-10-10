import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import {
  scrollPercent,
  scrollTranscript,
  shouldCaptureWheel,
  syncTranscriptScroll,
} from "../src/tui/scroll-controller.js";
import { InkTuiApp } from "../src/tui/ink-app.js";
import type { TuiAppOptions, TranscriptScrollState } from "../src/tui/types.js";

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

interface AppInternals {
  handleTerminalMouse: (event: { button: number; x: number; y: number; release: boolean }) => void;
}

/** A real InkTuiApp over a fake TTY, so the escape sequences it asks for can be inspected. */
function makeApp(): { app: InkTuiApp; writes: string[] } {
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const options = {
    input: output,
    output,
    getWorkspace: () => "ws",
    getModelLabel: () => "test-model",
  } as unknown as TuiAppOptions;
  return { app: new InkTuiApp(options, { render: (() => ({ unmount: () => {} })) as never }), writes };
}

describe("TUI transcript paging", () => {
  it("measures an offset against the window the frame renders, not the sealed history", () => {
    const { app } = makeApp();
    try {
      const state = app.snapshot();
      state.transcript.push({ id: "m0", kind: "assistant", text: "sealed line\n".repeat(60) });
      // The render commits everything that is not streaming to Static, so from here on the whole
      // conversation lives in the terminal's scrollback and the frame has no transcript lines left.
      expect(app.transcriptRenderSections(78).liveLines).toHaveLength(0);

      // Paging against the sealed 60 lines set an offset that the next render clamped back to 0,
      // which is what made PageUp — and the wheel — look dead.
      app.handleKey("", { pageUp: true } as Key);
      expect(app.scrollState().offsetFromBottom).toBe(0);
      expect(app.scrollState().followBottom).toBe(true);
    } finally {
      app.destroy();
    }
  });
});

/** Wheel ownership: the app may only hold a control the terminal gives up. */
describe("TUI wheel ownership", () => {
  const idle = { overlayOpen: false, detailsOpen: false, viewportLines: 20 };

  it("leaves the wheel to the host terminal when the app has nothing of its own to scroll", () => {
    // Idle: every message is committed to Static, so the live region is empty and the only way
    // back through history is the scrollback the terminal still owns.
    expect(shouldCaptureWheel({ ...idle, liveLines: 0, offsetFromBottom: 0 })).toBe(false);
    // A live region that fits the frame has nothing to scroll either.
    expect(shouldCaptureWheel({ ...idle, liveLines: 18, offsetFromBottom: 0 })).toBe(false);
    // A list overlay hides the transcript: the wheel has nothing to move behind it.
    expect(shouldCaptureWheel({ ...idle, overlayOpen: true, liveLines: 40, offsetFromBottom: 0 })).toBe(false);
  });

  it("takes the wheel while the app has lines of its own to scroll", () => {
    expect(shouldCaptureWheel({ ...idle, liveLines: 40, offsetFromBottom: 0 })).toBe(true);
    expect(shouldCaptureWheel({ ...idle, liveLines: 30, offsetFromBottom: 6 })).toBe(true);
    // The details overlay scrolls in-app at any size, so it always owns the wheel while open.
    expect(
      shouldCaptureWheel({ ...idle, overlayOpen: true, detailsOpen: true, liveLines: 0, offsetFromBottom: 0 }),
    ).toBe(true);
  });
});

describe("TUI wheel wiring", () => {
  it("writes the terminal's mouse mode only on a change of ownership", () => {
    const { app, writes } = makeApp();
    try {
      expect(writes).toEqual([]);
      app.syncWheelCapture(true);
      expect(writes.at(-1)).toContain("\x1b[?1000h");
      app.syncWheelCapture(true);
      expect(writes, "the same mode is not re-sent").toHaveLength(1);
      app.syncWheelCapture(false);
      expect(writes.at(-1)).toContain("\x1b[?1000l");
      expect(writes).toHaveLength(2);
    } finally {
      app.destroy();
    }
  });

  it("drops a wheel report that arrives while the terminal owns the wheel", () => {
    const { app } = makeApp();
    try {
      const internals = app as unknown as AppInternals;
      const state = app.snapshot();
      state.transcript.push({ id: "m1", kind: "assistant", text: "streaming line\n".repeat(60), streaming: true });

      // Released (no mouse mode requested): the report is stale and must not move the frame.
      internals.handleTerminalMouse({ button: 64, x: 1, y: 1, release: false });
      expect(app.scrollState().offsetFromBottom).toBe(0);

      app.syncWheelCapture(true);
      internals.handleTerminalMouse({ button: 64, x: 1, y: 1, release: false });
      expect(app.scrollState().offsetFromBottom).toBeGreaterThan(0);
      expect(app.scrollState().followBottom).toBe(false);
    } finally {
      app.destroy();
    }
  });
});
