import type { Widgets } from "blessed";

export interface TerminalCursorPosition {
  readonly row: number;
  readonly column: number;
}

const allocatedSizes = new WeakMap<Widgets.Screen, string>();

/** Render once without taking ownership of terminal modes or screen cleanup. */
export function renderTerminalFrame(screen: Widgets.Screen, cursor?: TerminalCursorPosition): void {
  screen.program.hideCursor();
  const size = `${screen.width}:${screen.height}`;
  if (allocatedSizes.get(screen) !== size) {
    allocatedSizes.set(screen, size);
    screen.realloc();
  }
  screen.render();
  screen.program.flush();
  if (!cursor) {
    screen.program.output.write("\x1b[?25l");
    return;
  }
  const row = Math.max(0, Math.floor(cursor.row)) + 1;
  const column = Math.max(0, Math.floor(cursor.column)) + 1;
  // Keep Blessed's tracked cursor in sync with the host terminal. Writing
  // CUP directly to output moves the real cursor but leaves program.x/y stale,
  // which corrupts the next incremental draw.
  screen.program.cup(row - 1, column - 1);
  screen.program.showCursor();
  screen.program.flush();
}

/** Coalesces Blessed paints and owns terminal cursor cleanup. */
export class TerminalWriter {
  private stopped = false;
  private renderQueued = false;
  private pendingCursor: TerminalCursorPosition | undefined;
  private pasteEnabled = false;

  constructor(private readonly screen: Widgets.Screen) {
    this.enableBracketedPaste();
  }

  private enableBracketedPaste(): void {
    if (this.pasteEnabled) return;
    this.pasteEnabled = true;
    this.screen.program.output.write("\x1b[?2004h");
  }

  requestRender(cursor?: TerminalCursorPosition): void {
    if (this.stopped) return;
    this.pendingCursor = cursor;
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => this.flush());
  }

  flush(): void {
    if (this.stopped || (!this.renderQueued && this.pendingCursor === undefined)) return;
    this.renderQueued = false;
    const cursor = this.pendingCursor;
    this.pendingCursor = undefined;
    renderTerminalFrame(this.screen, cursor);
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.renderQueued = false;
    this.pendingCursor = undefined;
    // Restore both the host cursor and bracketed-paste mode even when the
    // process exits while a render is queued.
    this.screen.program.output.write("\x1b[?25h\x1b[?2004l");
    this.screen.destroy();
  }
}
