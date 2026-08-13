import { describe, expect, it } from "vitest";
import { TuiTranscriptRenderer, type TuiRendererLayout } from "../src/tui/renderer.js";
import { createTuiState } from "../src/tui/state.js";
import { workingIndicatorLine } from "../src/tui/status-indicator.js";
import type { TuiState } from "../src/tui/types.js";
import type { RuntimeEvent } from "../src/types.js";

function createState(): TuiState {
  return createTuiState("D:\\workspace", "demo/chat");
}

let nextSequence = 0;

function event(value: Record<string, unknown>): RuntimeEvent {
  nextSequence += 1;
  return {
    version: 1,
    taskId: "task-1",
    sequence: nextSequence,
    timestamp: new Date(0).toISOString(),
    ...value,
  } as RuntimeEvent;
}

describe("TuiTranscriptRenderer", () => {
  it("accumulates deltas and does not duplicate final assistant text", () => {
    const state = createState();
    const layout = { redraw() {}, destroy() {} } as TuiRendererLayout;
    const renderer = new TuiTranscriptRenderer(layout, state);

    renderer.render(event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat" }));
    renderer.render(event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text: "hello" }));
    renderer.render(event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text: " world" }));
    renderer.render(event({
      type: "assistant_end",
      step: 0,
      source: "turn",
      attempt: 0,
      text: "hello world",
      toolCalls: [],
      usage: {},
      streamed: true,
    }));

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: "hello world", streaming: false });
    expect(state.streaming).toBe(false);
  });

  it("uses a non-empty final response to correct partial streamed text", () => {
    const state = createState();
    const layout = { redraw() {}, destroy() {} } as TuiRendererLayout;
    const renderer = new TuiTranscriptRenderer(layout, state);

    renderer.render(event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text: "helxo" }));
    renderer.render(event({
      type: "assistant_end",
      step: 0,
      source: "turn",
      attempt: 0,
      text: "hello",
      toolCalls: [],
      usage: {},
      streamed: true,
    }));

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: "hello", streaming: false });
  });

  it("hides the footer spinner while an assistant row streams", () => {
    const state = createState();
    state.streaming = true;
    state.transcript.push({ id: "assistant-1", kind: "assistant", text: "partial", streaming: true });

    expect(workingIndicatorLine(state, 0)).toBeUndefined();
  });
});
