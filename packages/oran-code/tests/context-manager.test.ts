import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_LIMITS, ContextManager } from "../src/context-manager.js";
import type { Message, ModelProvider, ModelResponse, ModelStreamChunk, ProviderRequestOptions } from "../src/types.js";

class SummaryProvider implements ModelProvider {
  readonly requests: Message[][] = [];

  async complete(messages: Message[]): Promise<ModelResponse> {
    this.requests.push(messages);
    return {
      text: [
        "<summary>",
        "### 1. Main Requests and Intent",
        "Preserve the active implementation context.",
        "### 2. Key Technical Concepts",
        "Context compaction and recovery.",
        "### 3. Files and Code Sections",
        "src/example.ts",
        "### 4. Errors and Fixes",
        "No unresolved errors.",
        "### 5. Problem-Solving Progress",
        "The requested change is in progress.",
        "### 6. User Messages",
        "This body is replaced with verbatim user messages.",
        "### 7. Pending Tasks",
        "Run the focused test.",
        "### 8. Current Work",
        "Testing ContextManager compaction.",
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
    throw new Error("streamResponse should not be called during context compaction");
  }
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "oran-context-manager-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function offloadedPath(replacement: string): string {
  const match = /^Full result: (.+)$/m.exec(replacement);
  if (!match?.[1]) throw new Error(`replacement did not contain a full-result path: ${replacement}`);
  return match[1];
}

describe("ContextManager tool-result offloading", () => {
  it("keeps a 50,000-byte result inline and offloads a 50,001-byte result without losing content", async () => {
    await withWorkspace(async (workspace) => {
      const manager = new ContextManager({ workspace });
      const atLimit = "a".repeat(CONTEXT_LIMITS.singleToolResultBytes);
      const overLimit = "b".repeat(CONTEXT_LIMITS.singleToolResultBytes + 1);

      const result = await manager.offloadToolResults([
        { id: "at-limit", content: atLimit },
        { id: "over-limit", content: overLimit },
      ]);

      expect(result.offloadedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.replacements.has("at-limit")).toBe(false);

      const replacement = result.replacements.get("over-limit");
      expect(replacement).toContain(`Original UTF-8 bytes: ${CONTEXT_LIMITS.singleToolResultBytes + 1}`);
      expect(replacement).toContain("Preview:");
      expect(replacement).toContain("Use read_file on");
      expect(await readFile(resolve(workspace, offloadedPath(replacement!)), "utf8")).toBe(overLimit);
    });
  });

  it("offloads the largest result first when a tool round exceeds 200,000 bytes", async () => {
    await withWorkspace(async (workspace) => {
      const manager = new ContextManager({ workspace });
      const candidates = [
        { id: "medium-1", content: "a".repeat(45_000) },
        { id: "largest", content: "b".repeat(49_000) },
        { id: "medium-2", content: "c".repeat(45_000) },
        { id: "medium-3", content: "d".repeat(45_000) },
        { id: "medium-4", content: "e".repeat(45_000) },
      ];

      const result = await manager.offloadToolResults(candidates);

      expect(candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.content), 0)).toBeGreaterThan(
        CONTEXT_LIMITS.toolRoundBytes,
      );
      expect(result.offloadedCount).toBe(1);
      expect([...result.replacements.keys()]).toEqual(["largest"]);
      const replacement = result.replacements.get("largest")!;
      expect(await readFile(resolve(workspace, offloadedPath(replacement)), "utf8")).toBe(candidates[1]!.content);
    });
  });

  it("ignores unsafe tool-call ids instead of creating an offload path", async () => {
    await withWorkspace(async (workspace) => {
      const manager = new ContextManager({ workspace });
      const result = await manager.offloadToolResults([
        { id: "../escape", content: "x".repeat(CONTEXT_LIMITS.singleToolResultBytes + 1) },
      ]);

      expect(result.offloadedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.replacements.size).toBe(0);
    });
  });
});

describe("ContextManager compaction", () => {
  it("preserves the stable prefix and emits summary and recovery context with recent files and tools", async () => {
    await withWorkspace(async (workspace) => {
      const manager = new ContextManager({ workspace });
      manager.trackSuccessfulFileRead(
        "src/example.ts",
        "export const recoveredValue = 42;",
        "2026-08-28T10:00:00.000Z",
      );
      const provider = new SummaryProvider();
      const tools = [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a workspace file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ];
      const stable: Message = {
        role: "system",
        content: "You are Oran code.",
        metadata: { promptBlock: "stable" },
      };
      const environment: Message = {
        role: "system",
        content: "Workspace: temporary fixture",
        metadata: { promptBlock: "environment" },
      };

      const result = await manager.compact({
        messages: [
          stable,
          environment,
          { role: "user", content: "Please update the example implementation." },
          { role: "assistant", content: "I inspected the relevant file." },
        ],
        provider,
        tools,
        contextWindow: 100_000,
        reason: "manual",
      });

      expect(result.messages.slice(0, 2)).toEqual([stable, environment]);
      const summary = result.messages.find((message) => message.metadata?.promptBlock === "context-summary");
      expect(summary?.content).toContain("<context-summary>");
      expect(summary?.content).toContain("### 1. Main Requests and Intent");
      expect(summary?.content).toContain("Please update the example implementation.");

      const recovery = result.messages.find((message) => message.metadata?.promptBlock === "context-recovery");
      expect(recovery?.content).toContain("<context-recovery>");
      expect(recovery?.content).toContain("Path: src/example.ts");
      expect(recovery?.content).toContain("export const recoveredValue = 42;");
      expect(recovery?.content).toContain('"name": "read_file"');
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.some((message) => message.content === stable.content)).toBe(false);
    });
  });
});
