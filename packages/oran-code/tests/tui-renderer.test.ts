import { describe, expect, it } from "vitest";
import { TuiTranscriptRenderer, type TuiRendererLayout } from "../src/tui/renderer.js";
import { createTuiState } from "../src/tui/state.js";
import { formatBackgroundTasksIndicator, workingIndicatorLine } from "../src/tui/status-indicator.js";
import { footerLines, workSummaryLine } from "../src/tui/footer.js";
import { staticTranscriptCount } from "../src/tui/ink-app.js";
import { collapsibleSegments, TranscriptView } from "../src/tui/transcript/transcript-view.js";
import { renderMessage } from "../src/tui/transcript/message-renderer.js";
import { ANSI } from "../src/tui/theme.js";
import type { TuiBackgroundTask, TuiState } from "../src/tui/types.js";
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

  it("keeps the current numbered-list tail visible while streaming", () => {
    const state = createState();
    state.transcript.push({
      id: "assistant-1",
      kind: "assistant",
      text: "1. first item\n2. second item is still streaming",
      streaming: true,
    });

    const rendered = new TranscriptView().lines(state, 80).join("\n");

    expect(rendered).toContain("first item");
    expect(rendered).toContain("second item is still streaming");
  });

  it("moves completed activity to Static even when the final assistant reply follows tools", () => {
    const state = createState();
    state.transcript.push(
      {
        id: "tool-1",
        kind: "tool",
        callId: "call-1",
        name: "read_file",
        arguments: {},
        permissionLevel: 0,
        status: "success",
        expanded: false,
      },
      { id: "assistant-1", kind: "assistant", text: "complete reply" },
    );

    expect(staticTranscriptCount(state.transcript)).toBe(2);

    state.transcript.push({
      id: "assistant-2",
      kind: "assistant",
      text: "partial",
      streaming: true,
    });
    expect(staticTranscriptCount(state.transcript)).toBe(2);
  });

  it("shows metrics after every completed task, including conversation-only turns", () => {
    const state = createState();
    state.session.taskState = "completed";
    state.session.elapsedMs = 1_500;
    state.session.outputTokensPerSecond = 20;
    state.activeTaskUsage = {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    state.transcript.push({ id: "user-1", kind: "user", text: "hello" });
    state.transcript.push({ id: "assistant-1", kind: "assistant", text: "hi" });

    expect(workSummaryLine(state)).toBe("✓ Done · 1.5s · 12 tokens (in 10, out 2) · 20 output tok/s");
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

  describe("Subagent Background Task Indicator", () => {
    it("formats single and multiple background subagent tasks", () => {
      const fixedNow = 1700000010000;
      const task1: TuiBackgroundTask = {
        id: "agent-1",
        name: "Searching codebase",
        definitionName: "explore",
        status: "running",
        startedAt: new Date(1700000000000).toISOString(),
      };
      expect(formatBackgroundTasksIndicator([task1], fixedNow)).toBe("[Subagent: explore] Searching codebase 10s");

      const task2: TuiBackgroundTask = {
        id: "agent-2",
        name: "tester",
        definitionName: "tester",
        status: "running",
        startedAt: new Date(1700000005000).toISOString(),
      };
      expect(formatBackgroundTasksIndicator([task1, task2], fixedNow)).toBe("[2 subagents running] explore (10s), tester (5.0s)");

      const completedTask: TuiBackgroundTask = {
        id: "agent-3",
        name: "done-agent",
        status: "completed",
        startedAt: new Date(1700000000000).toISOString(),
      };
      expect(formatBackgroundTasksIndicator([completedTask], fixedNow)).toBeUndefined();

      const queuedTask: TuiBackgroundTask = {
        id: "agent-4",
        name: "reviewer",
        definitionName: "reviewer",
        status: "queued",
        startedAt: new Date(1700000005000).toISOString(),
      };
      expect(formatBackgroundTasksIndicator([task1, queuedTask], fixedNow)).toBe("[1 subagents running (+1 queued)] explore (10s)");
      expect(formatBackgroundTasksIndicator([queuedTask], fixedNow)).toBe("[1 subagent queued: reviewer]");
    });

    it("renders workingIndicatorLine when session is idle but background tasks are running", () => {
      const state = createState();
      state.session.taskState = "completed";
      state.session.backgroundTasks = [
        {
          id: "agent-1",
          name: "explore",
          definitionName: "explore",
          status: "running",
          startedAt: new Date(1700000000000).toISOString(),
        },
      ];

      const line = workingIndicatorLine(state, 0, 1700000005000);
      expect(line).toBeDefined();
      expect(line).toContain("[Subagent: explore] 5.0s");
    });

    it("renders workingIndicatorLine showing both main activity and background tasks when busy", () => {
      const state = createState();
      state.session.taskState = "executing";
      state.session.backgroundTasks = [
        {
          id: "agent-1",
          name: "explore",
          definitionName: "explore",
          status: "running",
          startedAt: new Date(1700000000000).toISOString(),
        },
      ];

      const line = workingIndicatorLine(state, 0, 1700000005000);
      expect(line).toBeDefined();
      expect(line).toContain("Working...");
      expect(line).toContain("[Subagent: explore] 5.0s");
    });

    it("renders background task indicator in workingIndicatorLine even while streaming assistant content", () => {
      const state = createState();
      state.streaming = true;
      state.transcript.push({ id: "assistant-1", kind: "assistant", text: "partial", streaming: true });
      state.session.backgroundTasks = [
        {
          id: "agent-1",
          name: "explore",
          definitionName: "explore",
          status: "running",
          startedAt: new Date(1700000000000).toISOString(),
        },
      ];

      const line = workingIndicatorLine(state, 0, 1700000005000);
      expect(line).toBeDefined();
      expect(line).toContain("[Subagent: explore] 5.0s");
    });

    it("renders subagent count badge in footer and hides workSummaryLine when background tasks are active", () => {
      const state = createState();
      state.session.elapsedMs = 1500;
      state.session.taskState = "completed";
      state.session.backgroundTasks = [
        {
          id: "agent-1",
          name: "explore",
          definitionName: "explore",
          status: "running",
          startedAt: new Date().toISOString(),
        },
      ];

      expect(workSummaryLine(state)).toBeUndefined();

      const footer = footerLines(state, 100);
      expect(footer.join("\n")).toContain("1 subagent running");
    });
  });
});
