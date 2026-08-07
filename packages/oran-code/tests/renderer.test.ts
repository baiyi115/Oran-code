import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalRenderer } from "../src/renderer.js";
import type { RuntimeEvent, ToolCall } from "../src/types.js";

function capture(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { output, text: () => chunks.join("") };
}

const call: ToolCall = {
  id: "call_1",
  name: "read_file",
  arguments: { path: "README.md" },
  createdAt: new Date(0).toISOString(),
};

describe("TerminalRenderer", () => {
  it("renders a streamed assistant turn as a terminal transcript", () => {
    const captured = capture();
    const renderer = new TerminalRenderer(captured.output);
    renderer.render({
      version: 1,
      type: "assistant_start",
      taskId: "task-1",
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      step: 0,
      source: "turn",
      attempt: 0,
      model: "test-model",
    });
    renderer.render({
      version: 1,
      type: "assistant_delta",
      taskId: "task-1",
      sequence: 2,
      timestamp: new Date(0).toISOString(),
      step: 0,
      source: "turn",
      attempt: 0,
      text: "hello",
    });
    renderer.render({
      version: 1,
      type: "assistant_delta",
      taskId: "task-1",
      sequence: 3,
      timestamp: new Date(0).toISOString(),
      step: 0,
      source: "turn",
      attempt: 0,
      text: " world",
    });
    renderer.render({
      version: 1,
      type: "assistant_end",
      taskId: "task-1",
      sequence: 4,
      timestamp: new Date(0).toISOString(),
      step: 0,
      source: "turn",
      attempt: 0,
      text: "hello world",
      toolCalls: [],
      usage: {},
      streamed: true,
    });

    const text = captured.text();
    expect(text).toContain("Oran code [test-model] > ");
    expect(text).toContain("hello world");
    expect(text).not.toContain("\u001b[40m");
  });

  it("renders tool results, approvals, and verification status", () => {
    const captured = capture();
    const renderer = new TerminalRenderer(captured.output);
    renderer.toolStart(call, 0);
    renderer.toolResult(call, { ok: true, output: "README contents", summary: "read completed", durationMs: 12 });
    renderer.approval({ ...call, name: "apply_patch" }, 2, "Modify a tracked file");
    renderer.verify([{ command: "pnpm test", exitCode: 0, output: "passed", durationMs: 20, passed: true }]);

    const text = captured.text();
    expect(text).toContain("read_file L0");
    expect(text).toContain("ok: read completed (12ms)");
    expect(text).toContain("Approval required");
    expect(text).toContain("pnpm test exit=0");
  });
});
