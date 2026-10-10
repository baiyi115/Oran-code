import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context-manager.js";
import { CONTEXT_LIMITS } from "../src/context/limits.js";
import { selectRecentRawMessages } from "../src/context/pruner.js";
import type { Message, ModelProvider, ModelResponse, ModelStreamChunk, ProviderRequestOptions } from "../src/types.js";

class SummaryProvider implements ModelProvider {
  readonly requests: Message[][] = [];

  async complete(messages: Message[]): Promise<ModelResponse> {
    this.requests.push(messages);
    return {
      text: [
        "<summary>",
        "### 1. Main Requests and Intent",
        "Implement the requested change.",
        "### 2. Key Technical Concepts",
        "Context compaction and recovery.",
        "### 3. Files and Code Sections",
        "src/example.ts",
        "### 4. Errors and Fixes",
        "No unresolved errors.",
        "### 5. Problem-Solving Progress",
        "The change is in progress.",
        "### 6. User Messages",
        "This body is replaced with verbatim user messages.",
        "### 7. Pending Tasks",
        "Finish the change.",
        "### 8. Current Work",
        "Compaction testing.",
        "### 9. Possible Next Step",
        "Verify the compacted messages.",
        "</summary>",
      ].join("\n"),
      toolCalls: [],
      raw: {},
      usage: {},
      finishReason: "stop",
      streamed: false,
    };
  }

  async *streamResponse(
    _messages: Message[],
    _tools?: Record<string, unknown>[],
    _options?: ProviderRequestOptions,
  ): AsyncGenerator<ModelStreamChunk> {
    throw new Error("streamResponse is not used by compaction");
  }
}

function turn(index: number): Message[] {
  return [
    { role: "user", content: `User message:\nrequest ${index}` },
    { role: "assistant", content: `working on request ${index}` },
  ];
}

describe("compaction trigger", () => {
  it("triggers at 80% of a large window, before the hard budget threshold", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-compaction-"));
    try {
      const manager = new ContextManager({ workspace, conversation: [] });
      const contextWindow = 200_000;
      const hardThreshold = contextWindow - CONTEXT_LIMITS.summaryOutputTokens - CONTEXT_LIMITS.automaticSafetyTokens;
      let content = "a".repeat(560_000);
      let messages: Message[] = [{ role: "user", content }];
      let estimate = manager.estimateTokens(messages, []);
      // 调整到"已过 80% 触发点、尚未到 W−O−headroom"的区间。
      while (estimate < Math.floor(contextWindow * CONTEXT_LIMITS.automaticWindowFraction)) {
        content += "a".repeat(3_500);
        messages = [{ role: "user", content }];
        estimate = manager.estimateTokens(messages, []);
      }
      expect(estimate).toBeGreaterThanOrEqual(contextWindow * CONTEXT_LIMITS.automaticWindowFraction);
      expect(estimate).toBeLessThan(hardThreshold);
      expect(manager.shouldAutoCompact(messages, contextWindow)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the fixed-token floor for small windows", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-compaction-"));
    try {
      const manager = new ContextManager({ workspace, conversation: [] });
      const messages: Message[] = [{ role: "user", content: "small" }];
      // 小窗口下 W−O−headroom 为负,阈值退化为 1,压缩仍会立即触发(既有语义)。
      expect(manager.shouldAutoCompact(messages, 10_000)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("recent raw retention", () => {
  it("scales the retained tail with the context window", () => {
    const messages: Message[] = [];
    // 每轮约 4KB:总历史明显超过固定 12k token 预算,但小于 200k 窗口的 16%。
    for (let index = 0; index < 20; index += 1) {
      messages.push(
        { role: "user", content: `User message:\nrequest ${index} ${"u".repeat(2_000)}` },
        { role: "assistant", content: `working on request ${index} ${"a".repeat(2_000)}` },
      );
    }
    const fixed = selectRecentRawMessages(messages);
    const scaled = selectRecentRawMessages(messages, 200_000);
    expect(fixed.length).toBeLessThan(messages.length);
    expect(scaled.length).toBeGreaterThan(fixed.length);
    expect(scaled.length).toBe(messages.length);
  });
});

describe("incremental compaction", () => {
  it("carries the previous summary forward instead of summarizing it again", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-compaction-"));
    try {
      const provider = new SummaryProvider();
      const manager = new ContextManager({ workspace, conversation: [] });
      const messages: Message[] = [];
      for (let index = 0; index < 6; index += 1) messages.push(...turn(index));

      const first = await manager.compact({
        messages,
        provider,
        tools: [],
        contextWindow: 200_000,
        reason: "manual",
      });
      expect(provider.requests[0]?.[1]?.content).not.toContain("<existing-summary>");
      const firstSummary = first.messages.find((message) => message.metadata?.promptBlock === "context-summary");
      // 6 轮 = 12 条消息,覆盖统计按消息计数。
      expect(firstSummary?.metadata?.summaryCoverage).toMatchObject({ coveredMessages: 12 });

      // 第二批消息追加后再次压缩:请求里应携带上一份摘要,而不是把摘要再次摘要。
      const second: Message[] = [...first.messages, ...turn(6), ...turn(7)];
      const result = await manager.compact({
        messages: second,
        provider,
        tools: [],
        contextWindow: 200_000,
        reason: "manual",
      });
      const request = provider.requests[1]!;
      const userContent = String(request[1]?.content ?? "");
      expect(userContent).toContain("<existing-summary>");
      expect(userContent).toContain("request 0");

      const summary = result.messages.find((message) => message.metadata?.promptBlock === "context-summary");
      const summaryText = String(summary?.content ?? "");
      // 第 6 节保留旧用户消息原话 + 新消息,覆盖统计继续累计。
      expect(summaryText).toContain("request 0");
      expect(summaryText).toContain("request 6");
      const coverage = summary?.metadata?.summaryCoverage as { coveredMessages?: number; droppedGroups?: number };
      expect(coverage.coveredMessages ?? 0).toBeGreaterThan(12);
      expect(coverage.droppedGroups).toBe(0);
      expect(result.messages.filter((message) => message.role === "user").length).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
