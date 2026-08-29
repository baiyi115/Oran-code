import { describe, expect, it } from "vitest";
import { reduceRuntimeEvent } from "../src/tui/message-reducer.js";
import { createTuiState } from "../src/tui/state.js";
import type { RuntimeEvent, ToolCall } from "../src/types.js";

let sequence = 1;

function event(value: Record<string, unknown>, explicitSequence?: number): RuntimeEvent {
  return {
    version: 1,
    taskId: "task-1",
    sequence: explicitSequence ?? sequence++,
    timestamp: new Date(0).toISOString(),
    ...value,
  } as RuntimeEvent;
}

const call: ToolCall = {
  name: "run_command",
  arguments: { command: "pnpm test", apiKey: "sk-secret" },
  createdAt: "2026-08-04T00:00:00.000Z",
};

describe("TUI runtime event reducer", () => {
  it("ignores duplicate and out-of-order assistant terminal events", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(
      state,
      event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat", turnId: "turn-1" }, 2),
    );
    reduceRuntimeEvent(
      state,
      event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text: "hello", turnId: "turn-1" }, 3),
    );
    reduceRuntimeEvent(
      state,
      event(
        {
          type: "assistant_end",
          step: 0,
          source: "turn",
          attempt: 0,
          text: "hello",
          toolCalls: [],
          usage: {},
          streamed: true,
          turnId: "turn-1",
        },
        4,
      ),
    );
    reduceRuntimeEvent(
      state,
      event(
        {
          type: "assistant_end",
          step: 0,
          source: "turn",
          attempt: 0,
          text: "duplicate",
          toolCalls: [],
          usage: {},
          streamed: true,
          turnId: "turn-1",
        },
        5,
      ),
    );
    reduceRuntimeEvent(
      state,
      event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat", turnId: "turn-old" }, 1),
    );

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: "hello", streaming: false });
    expect(state.lastSequence).toBe(5);
  });

  it("correlates tool start and result without an explicit call id", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(state, event({ type: "tool_start", call, index: 1, permissionLevel: 4 }));
    reduceRuntimeEvent(
      state,
      event({
        type: "tool_result",
        call,
        index: 1,
        result: { ok: true, output: "all good", summary: "passed", durationMs: 12 },
      }),
    );
    reduceRuntimeEvent(
      state,
      event({
        type: "tool_result",
        call,
        index: 1,
        result: { ok: false, output: "late duplicate", summary: "failed", durationMs: 99 },
      }),
    );

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({
      kind: "tool",
      callId: "run_command:2026-08-04T00:00:00.000Z",
      status: "success",
      output: "all good",
      durationMs: 12,
    });
  });

  it("creates a completed tool when its result arrives first and redacts secrets", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(
      state,
      event({
        type: "tool_result",
        call,
        index: 1,
        result: { ok: true, output: "token=sk-secret", summary: "done" },
      }),
    );
    reduceRuntimeEvent(state, event({ type: "tool_start", call, index: 1, permissionLevel: 4 }));

    expect(state.transcript).toHaveLength(1);
    expect(JSON.stringify(state.transcript[0])).not.toContain("sk-secret");
    expect(state.transcript[0]).toMatchObject({ kind: "tool", status: "success" });
  });

  it("preserves usage when a later event omits totals and finishes cancellation", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(state, event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat" }));
    reduceRuntimeEvent(
      state,
      event({
        type: "assistant_end",
        step: 0,
        source: "turn",
        attempt: 0,
        text: "done",
        toolCalls: [],
        usage: { input_tokens: 5, output_tokens: 7 },
        streamed: true,
      }),
    );
    reduceRuntimeEvent(
      state,
      event({
        type: "assistant_end",
        step: 0,
        source: "turn",
        attempt: 0,
        text: "ignored",
        toolCalls: [],
        usage: {},
        streamed: true,
      }),
    );
    reduceRuntimeEvent(state, event({ type: "cancelled", message: "user cancelled" }));

    expect(state.session.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(state.session.taskState).toBe("cancelled");
    expect(state.streaming).toBe(false);
    expect(state.transcript).toHaveLength(1);
  });

  it("reconciles completed usage and stores authoritative timing metrics", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(state, event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat" }));
    reduceRuntimeEvent(
      state,
      event({
        type: "assistant_end",
        step: 0,
        source: "turn",
        attempt: 0,
        text: "done",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        streamed: true,
      }),
    );
    reduceRuntimeEvent(
      state,
      event({
        type: "completed",
        steps: 1,
        tokensUsed: 12,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        elapsedMs: 2_500,
        modelElapsedMs: 100,
        outputTokensPerSecond: 20,
      }),
    );

    expect(state.activeTaskUsage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    });
    expect(state.session.usage).toEqual(state.activeTaskUsage);
    expect(state.session.elapsedMs).toBe(2_500);
    expect(state.session.modelElapsedMs).toBe(100);
    expect(state.session.outputTokensPerSecond).toBe(20);
  });

  it("updates one retry notice and removes it before the terminal error", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(
      state,
      event({
        type: "retry",
        step: 0,
        source: "turn",
        attempt: 1,
        nextAttempt: 2,
        maxRetries: 5,
        message: "first failure",
      }),
    );
    reduceRuntimeEvent(
      state,
      event({
        type: "retry",
        step: 0,
        source: "turn",
        attempt: 2,
        nextAttempt: 3,
        maxRetries: 5,
        message: "second failure",
      }),
    );

    expect(state.transcript).toEqual([
      expect.objectContaining({ kind: "error", text: "retrying (3/5): second failure" }),
    ]);

    reduceRuntimeEvent(state, event({ type: "error", message: "request exhausted retries" }));

    expect(state.transcript).toEqual([expect.objectContaining({ kind: "error", text: "request exhausted retries" })]);
    expect(state.retryErrorId).toBeUndefined();
  });
});
