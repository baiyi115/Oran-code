import { describe, expect, it } from "vitest";
import { InkTuiApp } from "../src/tui/ink-app.js";
import type { TuiAppOptions } from "../src/tui/types.js";

/**
 * Regression test for render-commit scheduling: drives the real event-loop timing of
 * invalidate / flushPendingRender without starting real Ink.
 * Background: a revision swallowed inside the commit window (while Ink's reconciler / stdout
 * write is running) never gets a commit frame, and the assistant_end waiter waiting on it
 * suspends runtime events forever -- the TUI stops advancing after the task finishes and only
 * shows Done once the user stops it manually.
 */

interface RenderInternals {
  renderRevision: number;
  committedRenderRevision: number;
  inkInstance: { rerender: () => void; unmount: () => void } | undefined;
  invalidate: () => void;
}

function makeApp(): { app: InkTuiApp; internals: RenderInternals } {
  const fakeOutput = {
    isTTY: false,
    columns: 80,
    write: () => true,
  } as unknown as NodeJS.WriteStream;
  const options = {
    input: fakeOutput,
    output: fakeOutput,
    getWorkspace: () => "ws",
    getModelLabel: () => "test-model",
  } as unknown as TuiAppOptions;
  const app = new InkTuiApp(options, {
    render: (() => ({ unmount: () => {} })) as never,
  });
  const internals = app as unknown as RenderInternals;
  // Bypass real Ink, but keep the real timing of rerender/setImmediate.
  internals.inkInstance = { rerender: () => {}, unmount: () => {} };
  return { app, internals };
}

describe("TUI render commit scheduling", () => {
  it("commits revisions bumped inside the ink commit window (regression: assistant_end deadlock)", async () => {
    const { app, internals } = makeApp();
    try {
      internals.invalidate(); // revision 1 enters scheduling
      await Promise.resolve(); // the microtask captures revision 1 and enters the commit window
      internals.invalidate(); // inside the commit window revision rises to 2 (swallowed before the fix)

      const pending = app.flushPendingRender("terminal"); // register a waiter for revision 2
      await pending; // before the fix this promise hung forever
      expect(internals.committedRenderRevision).toBe(2);
    } finally {
      app.destroy();
    }
  });

  it("releases boundary waits instead of hanging when a commit never arrives", async () => {
    const { app, internals } = makeApp();
    try {
      // Simulate a revision that has advanced while the commit frame never arrives (degraded case).
      internals.renderRevision = 7;
      const started = Date.now();
      await app.flushPendingRender("terminal");
      expect(Date.now() - started).toBeLessThan(5_000);
      // The fallback path forces one extra render, so committed should catch up with revision
      // (the extra render itself bumps revision again, hence >= rather than exact equality).
      expect(internals.committedRenderRevision).toBeGreaterThanOrEqual(7);
    } finally {
      app.destroy();
    }
  });

  it("normal commits return immediately without waiting for a frame", async () => {
    const { app, internals } = makeApp();
    try {
      internals.invalidate();
      // The normal kind registers no waiter and returns immediately even if revision has not committed yet.
      await expect(app.flushPendingRender("normal")).resolves.toBeUndefined();
    } finally {
      app.destroy();
    }
  });
});
