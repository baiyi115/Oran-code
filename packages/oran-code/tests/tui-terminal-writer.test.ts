import { describe, expect, it, vi } from "vitest";
import { TerminalWriter } from "../src/tui/terminal-writer.js";

function screen() {
  return {
    render: vi.fn(),
    realloc: vi.fn(),
    destroy: vi.fn(),
    program: {
      hideCursor: vi.fn(),
      cup: vi.fn(),
      showCursor: vi.fn(),
      flush: vi.fn(),
      output: { write: vi.fn() },
    },
  } as any;
}

describe("TerminalWriter", () => {
  it("owns bracketed paste and coalesces renders", async () => {
    const fake = screen();
    const writer = new TerminalWriter(fake);
    expect(fake.program.output.write).toHaveBeenCalledWith("\x1b[?2004h");

    writer.requestRender({ row: 2, column: 3 });
    writer.requestRender({ row: 4, column: 5 });
    await Promise.resolve();

    expect(fake.render).toHaveBeenCalledOnce();
    expect(fake.realloc).toHaveBeenCalledOnce();
    expect(fake.program.flush).toHaveBeenCalledTimes(2);
    expect(fake.program.cup).toHaveBeenCalledWith(4, 5);
    expect(fake.program.showCursor).toHaveBeenCalledOnce();
  });

  it("restores terminal state once and is inert after destroy", async () => {
    const fake = screen();
    const writer = new TerminalWriter(fake);
    writer.requestRender({ row: 1, column: 1 });
    writer.destroy();
    writer.destroy();
    await Promise.resolve();
    writer.requestRender({ row: 5, column: 5 });

    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(fake.program.output.write).toHaveBeenLastCalledWith("\x1b[?25h\x1b[?2004l");
    expect(fake.render).not.toHaveBeenCalled();
  });
});
