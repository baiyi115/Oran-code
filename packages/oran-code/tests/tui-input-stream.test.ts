import { Readable, type Transform } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBracketedPasteStream, type TerminalMouseEvent } from "../src/tui/terminal-streams.js";

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  return out;
}

function streamWithMouse(chunks: string[]): { stream: Transform; events: TerminalMouseEvent[] } {
  const events: TerminalMouseEvent[] = [];
  const source = Readable.from(chunks);
  const stream = createBracketedPasteStream(source as NodeJS.ReadableStream, {
    onMouse: (event) => events.push(event),
  });
  return { stream, events };
}

describe("terminal input stream mouse reporting", () => {
  it("strips SGR wheel reports and forwards parsed events", async () => {
    const { stream, events } = streamWithMouse(["ab", "\x1b[<64;12;34M", "\x1b[<65;12;34M", "c"]);
    expect(await collect(stream)).toBe("abc");
    expect(events).toEqual([
      { button: 64, x: 11, y: 33, release: false },
      { button: 65, x: 11, y: 33, release: false },
    ]);
  });

  it("handles a mouse report split across chunks without leaking bytes", async () => {
    const { stream, events } = streamWithMouse(["x\x1b[<64;3", "0;9M", "y"]);
    expect(await collect(stream)).toBe("xy");
    expect(events).toEqual([{ button: 64, x: 29, y: 8, release: false }]);
  });

  it("strips legacy X10 mouse reports", async () => {
    // \x1b[M + button/x/y each offset by 32
    const legacy = `\x1b[M${String.fromCharCode(64 + 32, 11 + 32, 8 + 32)}`;
    const { stream, events } = streamWithMouse([legacy]);
    expect(await collect(stream)).toBe("");
    expect(events).toEqual([{ button: 64, x: 10, y: 7, release: false }]);
  });

  it("leaves mouse-looking bytes inside a bracketed paste untouched", async () => {
    const paste = `\x1b[200~payload \x1b[<64;1;1M text\x1b[201~`;
    const { stream, events } = streamWithMouse([paste]);
    expect(await collect(stream)).toBe("payload \x1b[<64;1;1M text");
    expect(events).toEqual([]);
  });

  it("passes ordinary input through unchanged when no mouse sequences appear", async () => {
    const { stream, events } = streamWithMouse(["hello", " 世界", "\n"]);
    expect(await collect(stream)).toBe("hello 世界\n");
    expect(events).toEqual([]);
  });

  it("flushes a dangling prefix as plain input after the timeout", async () => {
    const { stream, events } = streamWithMouse(["ab\x1b[<6"]);
    let received = "";
    stream.on("data", (chunk) => {
      received += String(chunk);
    });
    // The source never ends: verifies that a dangling prefix is passed through as plain
    // keystrokes after the timeout window instead of being swallowed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    stream.destroy();
    expect(received).toBe("ab\x1b[<6");
    expect(events).toEqual([]);
  });
});
