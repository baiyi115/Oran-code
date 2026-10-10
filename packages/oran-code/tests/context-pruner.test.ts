import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_LIMITS } from "../src/context/limits.js";
import { offloadConversation, type PrunerLedger } from "../src/context/pruner.js";
import { buildClearedReplacement, buildToolReplacement } from "../src/context/spill.js";
import type { Message } from "../src/types.js";

function ledger(): PrunerLedger {
  return { seenIds: new Set(), replacements: new Map(), offloadFailures: new Map() };
}

/** 一轮 = assistant 工具调用 + 对应 tool 结果,便于构造"历史轮"。 */
function toolRound(id: string, content: string): Message[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: { path: "src/app.ts" }, createdAt: "2026-09-24T00:00:00.000Z" }],
    },
    { role: "tool", toolCallId: id, content },
  ];
}

interface SpillRecorder {
  spill: (id: string, content: string) => Promise<string | undefined>;
  readonly spilled: Map<string, string>;
  readonly calls: string[];
}

function makeSpillWriter(directory: string, options: { fail?: boolean } = {}): SpillRecorder {
  const spilled = new Map<string, string>();
  const calls: string[] = [];
  return {
    spilled,
    calls,
    spill: async (id: string, content: string) => {
      calls.push(id);
      if (options.fail) return undefined;
      const relativePath = `.oran/tool-results/${id}`;
      await mkdir(join(directory, ".oran", "tool-results"), { recursive: true });
      await writeFile(join(directory, relativePath), content, "utf8");
      spilled.set(id, content);
      return relativePath;
    },
  };
}

describe("microcompact", () => {
  async function runCase(toolResultBytes: number, rounds: number) {
    const workspace = await mkdtemp(join(tmpdir(), "oran-pruner-"));
    const writer = makeSpillWriter(workspace);
    const content = "x".repeat(toolResultBytes);
    const messages: Message[] = [{ role: "user", content: "read files" }];
    for (let index = 0; index < rounds; index += 1) {
      messages.push(...toolRound(`call_${index}`, `${content}#${index}`));
    }
    const result = await offloadConversation(ledger(), messages, writer.spill);
    return { workspace, writer, messages: result.messages, result };
  }

  it("clears the body of older tool results and keeps the recent ones verbatim", async () => {
    const rounds = CONTEXT_LIMITS.microcompactKeepResults + 3;
    const { workspace, writer, messages } = await runCase(6_000, rounds);
    try {
      const toolMessages = messages.filter((message) => message.role === "tool");
      expect(toolMessages).toHaveLength(rounds);
      for (const [index, message] of toolMessages.entries()) {
        if (index < 3) {
          expect(message.content).toContain("<cleared-tool-result>");
          expect(message.content).toContain(`.oran/tool-results/call_${index}`);
          // 原文仍然落盘可读回。
          expect(writer.spilled.get(`call_${index}`)).toContain(`#${index}`);
          const onDisk = await readFile(join(workspace, `.oran/tool-results/call_${index}`), "utf8");
          expect(onDisk).toBe(writer.spilled.get(`call_${index}`));
        } else {
          expect(message.content).toContain(`#${index}`);
          expect(message.content).not.toContain("<cleared-tool-result>");
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("leaves small results alone and never clears them twice", async () => {
    const rounds = CONTEXT_LIMITS.microcompactKeepResults + 2;
    const workspace = await mkdtemp(join(tmpdir(), "oran-pruner-"));
    const writer = makeSpillWriter(workspace);
    const messages: Message[] = [{ role: "user", content: "read files" }];
    messages.push(...toolRound("call_small", "tiny output"));
    for (let index = 0; index < rounds; index += 1) {
      messages.push(...toolRound(`call_${index}`, `${"y".repeat(6_000)}#${index}`));
    }
    const state = ledger();
    try {
      const first = await offloadConversation(state, messages, writer.spill);
      const small = first.messages.find((message) => message.toolCallId === "call_small");
      expect(small?.content).toBe("tiny output");
      expect(writer.calls).not.toContain("call_small");

      const clearedBefore = first.messages.filter((m) => m.content?.startsWith("<cleared-tool-result>")).length;
      expect(clearedBefore).toBe(2);
      const second = await offloadConversation(state, first.messages, writer.spill);
      expect(second.replacementCount).toBe(0);
      expect(second.messages.filter((m) => m.content?.startsWith("<cleared-tool-result>")).length).toBe(clearedBefore);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the original content when spilling fails", async () => {
    const rounds = CONTEXT_LIMITS.microcompactKeepResults + 1;
    const workspace = await mkdtemp(join(tmpdir(), "oran-pruner-"));
    const writer = makeSpillWriter(workspace, { fail: true });
    const messages: Message[] = [{ role: "user", content: "read files" }];
    for (let index = 0; index < rounds; index += 1) {
      messages.push(...toolRound(`call_${index}`, `${"z".repeat(5_000)}#${index}`));
    }
    try {
      const output = await offloadConversation(ledger(), messages, writer.spill);
      const first = output.messages.find((message) => message.toolCallId === "call_0");
      expect(first?.content).toContain("#0");
      expect(first?.content).not.toContain("<cleared-tool-result>");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("spill placeholders", () => {
  it("points the model at both read_file and search_code", () => {
    const offloaded = buildToolReplacement("body", 4, ".oran/x");
    expect(offloaded).toContain("read_file");
    expect(offloaded).toContain("search_code");
    const cleared = buildClearedReplacement(4_000, ".oran/x");
    expect(cleared).toContain("<cleared-tool-result>");
    expect(cleared).toContain("Original UTF-8 bytes: 4000");
    expect(cleared).toContain("search_code");
  });
});
