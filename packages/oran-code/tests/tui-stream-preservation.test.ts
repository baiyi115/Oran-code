import { describe, expect, it } from "vitest";
import { staticTranscriptCount } from "../src/tui/ink-app.js";
import { reduceRuntimeEvent } from "../src/tui/message-reducer.js";
import { renderMessage } from "../src/tui/transcript/message-renderer.js";
import { createTuiState } from "../src/tui/state.js";
import type { RuntimeEvent } from "../src/types.js";

let sequence = 0;

function event(value: Record<string, unknown>): RuntimeEvent {
  sequence += 1;
  return {
    version: 1,
    taskId: "task-1",
    sequence,
    timestamp: new Date(0).toISOString(),
    ...value,
  } as RuntimeEvent;
}

function visible(lines: string): string {
  // eslint-disable-next-line no-control-regex -- 控制字符是刻意匹配的目标（ANSI 转义/文本清洗）
  return lines.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("streamed TUI text preservation", () => {
  it("keeps the final delta, Chinese text, and split surrogate pairs through completion", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");
    const deltas = ["第一段完整内容。", "第二段", "\ud83d"];
    const expected = `${deltas.join("")}\ude00`;

    reduceRuntimeEvent(state, event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat" }));
    for (const text of deltas) {
      reduceRuntimeEvent(state, event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text }));
    }

    expect(state.transcript[0]).toMatchObject({ kind: "assistant", streaming: true });
    expect(staticTranscriptCount(state.transcript)).toBe(0);

    reduceRuntimeEvent(
      state,
      event({
        type: "assistant_end",
        step: 0,
        source: "turn",
        attempt: 0,
        text: expected,
        toolCalls: [],
        usage: {},
        streamed: true,
      }),
    );

    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: expected, streaming: false });
    expect(state.streaming).toBe(false);
    expect(staticTranscriptCount(state.transcript)).toBe(1);
  });

  it("preserves partial assistant text when the task is cancelled", () => {
    const state = createTuiState("D:\\workspace", "demo/chat");

    reduceRuntimeEvent(state, event({ type: "assistant_start", step: 0, source: "turn", attempt: 0, model: "chat" }));
    reduceRuntimeEvent(
      state,
      event({ type: "assistant_delta", step: 0, source: "turn", attempt: 0, text: "部分回答仍然" }),
    );
    reduceRuntimeEvent(state, event({ type: "cancelled", message: "user cancelled" }));

    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: "部分回答仍然", streaming: false });
    expect(state.streaming).toBe(false);
    expect(state.session.taskState).toBe("cancelled");
  });

  it("renders incomplete markdown tails without dropping their content", () => {
    const cases = [
      { input: "```ts\nconst done = true", expected: "const done = true" },
      { input: "**bold token", expected: "bold token" },
      { input: "[label](https://example.test/missing", expected: "label" },
    ];

    for (const { input, expected } of cases) {
      const streaming = renderMessage(
        {
          id: "assistant-streaming",
          kind: "assistant",
          text: input,
          streaming: true,
        },
        100,
      ).join("\n");
      const completed = renderMessage(
        {
          id: "assistant-completed",
          kind: "assistant",
          text: input,
        },
        100,
      ).join("\n");

      expect(visible(streaming)).toContain(expected);
      expect(visible(completed)).toContain(expected);
    }
  });

  it("renders a partial markdown table while it is still streaming", () => {
    const lines = renderMessage(
      {
        id: "assistant-table",
        kind: "assistant",
        text: "| A | B |\n| --- | --- |\n| 1 |",
        streaming: true,
      },
      100,
    );

    const rendered = visible(lines.join("\n"));
    expect(rendered).toContain("A");
    expect(rendered).toContain("B");
    expect(rendered).toContain("1");
  });
});
