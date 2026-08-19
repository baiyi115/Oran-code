import { describe, expect, it } from "vitest";
import { TuiTranscriptRenderer, type TuiRendererLayout } from "../src/tui/renderer.js";
import { createTuiState } from "../src/tui/state.js";
import { workingIndicatorLine } from "../src/tui/status-indicator.js";
import { collapsibleSegments, TranscriptView } from "../src/tui/transcript/transcript-view.js";
import { renderMessage } from "../src/tui/transcript/message-renderer.js";
import { ANSI } from "../src/tui/theme.js";
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

  it("collapses a finished thought and consecutive successful tools into one expandable segment", () => {
    const state = createState();
    state.transcript.push(
      {
        id: "thought-0",
        kind: "thought" as const,
        text: "Inspect the relevant files.",
        durationMs: 2_200,
        expanded: false,
      },
      ...["read_file", "search_code", "list_files"].map((name, index) => ({
        id: `tool-${index}`,
        kind: "tool" as const,
        callId: `call-${index}`,
        name,
        arguments: {},
        permissionLevel: 0,
        status: "success" as const,
        expanded: false,
      })),
    );
    const view = new TranscriptView();

    const collapsed = view.lines(state, 80).join("\n");
    expect(collapsed).toContain("Thought for 2.2s");
    expect(collapsed).toContain("3 tools");
    expect(collapsed).not.toContain("Inspect the relevant files.");

    const segment = collapsibleSegments(state.transcript)[0]!;
    state.expandedToolGroupIds.add(segment.id);
    const expanded = view.lines(state, 80).join("\n");
    expect(expanded).not.toContain("3 tools");
    expect(expanded).toContain("Inspect the relevant files.");
    expect(expanded).toContain("Read");
    expect(expanded).toContain("Search");
    expect(expanded).toContain("List");
  });

  it("keeps the primary error visible and mutes retry details", () => {
    const lines = renderMessage({
      id: "error-1",
      kind: "error",
      text: "Attempt 1/6 failed: model API returned 503:\n{\"error\":{\"message\":\"busy\"}}\nRetrying (1/5)...",
    }, 120);

    expect(lines[0]).toContain(`${ANSI.redBold}Error${ANSI.reset}`);
    expect(lines[0]).toContain("Attempt 1/6 failed: model API returned 503:");
    expect(lines[0]).not.toContain(ANSI.gray);
    const mutedDetails = lines.filter((line) => line.includes("busy") || line.includes("Retrying"));
    expect(mutedDetails).not.toHaveLength(0);
    expect(mutedDetails.every((line) => line.includes(ANSI.gray))).toBe(true);
  });
});
