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

/** Compact six turns and return the summary text the model would read. */
async function compactWith(provider: ModelProvider): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "oran-compaction-"));
  try {
    const messages: Message[] = [];
    for (let index = 0; index < 6; index += 1) messages.push(...turn(index));
    const result = await new ContextManager({ workspace, conversation: [] }).compact({
      messages,
      provider,
      tools: [],
      contextWindow: 200_000,
      reason: "manual",
    });
    const summary = result.messages.find((message) => message.metadata?.promptBlock === "context-summary");
    return String(summary?.content ?? "");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
      // Tune into the "past the 80% trigger, not yet at W−O−headroom" range.
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
      // For a small window W−O−headroom goes negative, so the threshold degrades to 1 and
      // compaction still fires immediately (existing semantics).
      expect(manager.shouldAutoCompact(messages, 10_000)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("recent raw retention", () => {
  it("scales the retained tail with the context window", () => {
    const messages: Message[] = [];
    // Each turn is about 4KB: total history clearly exceeds the fixed 12k token budget, but
    // stays below 16% of the 200k window.
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

describe("summary tail retention", () => {
  /** A summary whose later headings are decorated differently from the earlier ones. */
  class MixedHeadingProvider implements ModelProvider {
    async complete(): Promise<ModelResponse> {
      return {
        text: [
          "<summary>",
          "### 1. Main Requests and Intent",
          "Do the thing.",
          "### 2. Key Technical Concepts",
          "Compaction.",
          "### 3. Files and Code Sections",
          "src/example.ts",
          "### 4. Errors and Fixes",
          "None.",
          "### 5. Problem-Solving Progress",
          "In progress.",
          "### 6. User Messages",
          "This body is replaced with the verbatim messages.",
          "**7. Pending Tasks**",
          "Finish the thing.",
          "**8. Current Work**",
          "Halfway through the change.",
          "**9. Possible Next Step**",
          "Run the test suite.",
          "</summary>",
        ].join("\n"),
        toolCalls: [],
        raw: {},
        usage: {},
        finishReason: "stop",
        streamed: false,
      };
    }

    async *streamResponse(): AsyncGenerator<ModelStreamChunk> {
      throw new Error("streamResponse is not used by compaction");
    }
  }

  /** A summary that simply stops after the user-message section. */
  class TruncatedTailProvider implements ModelProvider {
    async complete(): Promise<ModelResponse> {
      return {
        text: [
          "<summary>",
          "### 1. Main Requests and Intent",
          "Do the thing.",
          "### 2. Key Technical Concepts",
          "Compaction.",
          "### 3. Files and Code Sections",
          "src/example.ts",
          "### 4. Errors and Fixes",
          "None.",
          "### 5. Problem-Solving Progress",
          "In progress.",
          "### 6. User Messages",
          "This body is replaced with the verbatim messages.",
          "</summary>",
        ].join("\n"),
        toolCalls: [],
        raw: {},
        usage: {},
        finishReason: "stop",
        streamed: false,
      };
    }

    async *streamResponse(): AsyncGenerator<ModelStreamChunk> {
      throw new Error("streamResponse is not used by compaction");
    }
  }

  it("keeps the sections whose headings were not written with # marks", async () => {
    // Headings are recognised as #{1,6}, so a bold "**7. Pending Tasks**" was not a
    // heading — and the tail was taken from that (unmatched) heading's position,
    // which is the end of the text: sections 7-9 disappeared while the compaction
    // reported success, taking the plan state and the next step with them.
    const summary = await compactWith(new MixedHeadingProvider());
    expect(summary).toContain("Finish the thing.");
    expect(summary).toContain("Halfway through the change.");
    expect(summary).toContain("Run the test suite.");
    expect(summary).toContain("request 0");
  });

  it("says so when the reply stops before those sections", async () => {
    const summary = await compactWith(new TruncatedTailProvider());
    expect(summary).toContain("Pending Tasks");
    expect(summary).toContain("this section was not recognised in the reply");
  });
});

describe("truncated summary replies", () => {
  const HEAD = [
    "### 1. Main Requests and Intent",
    "Do the thing.",
    "### 2. Key Technical Concepts",
    "Context compaction and recovery.",
    "### 3. Files and Code Sections",
    "src/example.ts",
    "### 4. Errors and Fixes",
    "None unresolved.",
    "### 5. Problem-Solving Progress",
    "The change is in progress.",
    "### 6. User Messages",
    "This body is replaced with the verbatim messages.",
  ];
  const TAIL = [
    "### 7. Pending Tasks",
    "Finish the thing.",
    "### 8. Current Work",
    "Halfway through the change.",
    "### 9. Possible Next Step",
    "Run the test suite.",
  ];

  /** Replies that report being cut off by the output limit. */
  class TruncatingProvider implements ModelProvider {
    calls = 0;

    constructor(private readonly truncateThrough: number) {}

    async complete(): Promise<ModelResponse> {
      this.calls += 1;
      const truncated = this.calls <= this.truncateThrough;
      return {
        text: ["<summary>", ...(truncated ? HEAD : [...HEAD, ...TAIL]), "</summary>"].join("\n"),
        truncated,
        toolCalls: [],
        raw: {},
        usage: {},
        finishReason: truncated ? "length" : "stop",
        streamed: false,
      };
    }

    async *streamResponse(): AsyncGenerator<ModelStreamChunk> {
      throw new Error("streamResponse is not used by compaction");
    }
  }

  it("asks again when the reply was cut off, and keeps the complete one", async () => {
    // A cut-off reply holds only part of the nine sections, and the recovery path
    // accepts whatever follows an opening <summary> tag: the half-written hand-off
    // used to be stored as complete.
    const provider = new TruncatingProvider(1);
    const summary = await compactWith(provider);
    expect(provider.calls).toBe(2);
    expect(summary).not.toContain("cut off by the output limit");
    expect(summary).toContain("Run the test suite.");
  });

  it("says the summary is partial when every reply was cut off", async () => {
    const provider = new TruncatingProvider(Number.POSITIVE_INFINITY);
    const summary = await compactWith(provider);
    expect(provider.calls).toBeGreaterThan(1);
    expect(summary).toContain("cut off by the output limit");
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
      // 6 turns = 12 messages; coverage counts by message.
      expect(firstSummary?.metadata?.summaryCoverage).toMatchObject({ coveredMessages: 12 });

      // Compact again after appending the second batch: the request should carry the previous
      // summary rather than summarizing the summary again.
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
      // Section 6 keeps the old user message verbatim plus the new message; coverage keeps accumulating.
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
