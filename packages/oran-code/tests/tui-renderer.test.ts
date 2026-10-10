import { describe, expect, it } from "vitest";
import { TuiTranscriptRenderer, type TuiRendererLayout } from "../src/tui/renderer.js";
import { createTuiState } from "../src/tui/state.js";
import {
  subagentTaskLines,
  TASK_PANEL_MAX_ROWS,
  TASK_PANEL_RECENT_DONE_MS,
  workingIndicatorLine,
} from "../src/tui/status-indicator.js";
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
    renderer.render(
      event({
        type: "assistant_end",
        step: 0,
        source: "turn",
        attempt: 0,
        text: "hello world",
        toolCalls: [],
        usage: {},
        streamed: true,
      }),
    );

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: "hello world", streaming: false });
    expect(state.streaming).toBe(false);
  });

  it("uses a non-empty final response to correct partial streamed text", () => {
    const state = createState();
    const layout = { redraw() {}, destroy() {} } as TuiRendererLayout;
    const renderer = new TuiTranscriptRenderer(layout, state);

    renderer.render(event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text: "helxo" }));
    renderer.render(
      event({
        type: "assistant_end",
        step: 0,
        source: "turn",
        attempt: 0,
        text: "hello",
        toolCalls: [],
        usage: {},
        streamed: true,
      }),
    );

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
    const lines = renderMessage(
      {
        id: "error-1",
        kind: "error",
        text: 'Attempt 1/6 failed: model API returned 503:\n{"error":{"message":"busy"}}\nRetrying (1/5)...',
      },
      120,
    );

    expect(lines[0]).toContain(`${ANSI.redBold}Error${ANSI.reset}`);
    expect(lines[0]).toContain("Attempt 1/6 failed: model API returned 503:");
    expect(lines[0]).not.toContain(ANSI.gray);
    const mutedDetails = lines.filter((line) => line.includes("busy") || line.includes("Retrying"));
    expect(mutedDetails).not.toHaveLength(0);
    expect(mutedDetails.every((line) => line.includes(ANSI.gray))).toBe(true);
  });

  describe("Subagent task panel", () => {
    const fixedNow = 1700000010000;

    it("renders one row per active subagent with role, task description, and elapsed time", () => {
      const task1: TuiBackgroundTask = {
        id: "agent-1",
        name: "Searching codebase",
        definitionName: "explore",
        status: "running",
        startedAt: new Date(1700000000000).toISOString(),
      };
      const rows = subagentTaskLines([task1], 0, fixedNow, 100);
      expect(rows).toEqual([{ text: "⠋ explore · Searching codebase · 10s", tone: "running" }]);

      const queuedTask: TuiBackgroundTask = {
        id: "agent-2",
        name: "reviewer",
        definitionName: "reviewer",
        status: "queued",
        startedAt: new Date(1700000005000).toISOString(),
      };
      expect(subagentTaskLines([task1, queuedTask], 0, fixedNow, 100)).toEqual([
        { text: "⠋ explore · Searching codebase · 10s", tone: "running" },
        { text: "… reviewer · queued", tone: "queued" },
      ]);
    });

    it("keeps recently finished subagents visible for a window, then hides them", () => {
      const doneTask: TuiBackgroundTask = {
        id: "agent-3",
        name: "done-agent",
        status: "completed",
        startedAt: new Date(1700000000000).toISOString(),
        endedAt: new Date(1700000004000).toISOString(),
      };
      const rows = subagentTaskLines([doneTask], 0, fixedNow, 100);
      expect(rows).toEqual([{ text: "✓ done-agent · completed 4.0s", tone: "done" }]);

      const later = fixedNow + TASK_PANEL_RECENT_DONE_MS + 1_000;
      expect(subagentTaskLines([doneTask], 0, later, 100)).toEqual([]);
    });

    it("marks failed subagents and skips shell jobs", () => {
      const failedTask: TuiBackgroundTask = {
        id: "agent-9",
        name: "audit",
        status: "failed",
        startedAt: new Date(1700000000000).toISOString(),
        endedAt: new Date(1700000002000).toISOString(),
      };
      const jobTask: TuiBackgroundTask = {
        id: "job-1",
        name: "pnpm dev",
        kind: "job",
        status: "running",
        startedAt: new Date(1700000000000).toISOString(),
      };
      expect(subagentTaskLines([failedTask, jobTask], 0, fixedNow, 100)).toEqual([
        { text: "✗ audit · failed 2.0s", tone: "failed" },
      ]);
    });

    it("caps the panel and folds older overflow into a hint row", () => {
      const tasks: TuiBackgroundTask[] = Array.from({ length: 8 }, (_, index) => ({
        id: `agent-${index}`,
        name: `task-${index}`,
        status: "running",
        startedAt: new Date(1700000000000).toISOString(),
      }));
      const rows = subagentTaskLines(tasks, 0, fixedNow, 100);
      expect(rows).toHaveLength(TASK_PANEL_MAX_ROWS);
      expect(rows[TASK_PANEL_MAX_ROWS - 1]).toEqual({
        text: `… +${8 - (TASK_PANEL_MAX_ROWS - 1)} more (/tasks for all)`,
        tone: "queued",
      });
    });

    it("truncates long task descriptions but keeps the timing suffix alive", () => {
      const task: TuiBackgroundTask = {
        id: "agent-1",
        name: "A".repeat(200),
        status: "running",
        startedAt: new Date(1700000000000).toISOString(),
      };
      const [row] = subagentTaskLines([task], 0, fixedNow, 40);
      expect(row).toBeDefined();
      expect(row!.text).toContain("· 10s");
      expect(row!.text.length).toBeLessThanOrEqual(40);
    });

    it("workingIndicatorLine leaves subagents to the panel and keeps only shell jobs", () => {
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
      expect(line).not.toContain("Subagent");
    });

    it("renders workingIndicatorLine as undefined while streaming with only subagents running", () => {
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

      expect(workingIndicatorLine(state, 0, 1700000005000)).toBeUndefined();
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
