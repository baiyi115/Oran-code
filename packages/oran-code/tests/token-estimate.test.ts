import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context-manager.js";
import type { Message } from "../src/types.js";

function manager(): ContextManager {
  return new ContextManager({ workspace: "/workspace", conversation: [] });
}

describe("script-aware token estimation", () => {
  it("estimates ASCII payloads near the classic bytes/3.5 heuristic", () => {
    const messages: Message[] = [{ role: "user", content: "plain ascii engineering request about tooling".repeat(20) }];
    const estimate = manager().estimateTokens(messages, []);
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools: [] }), "utf8");
    // ASCII: same order of magnitude as the old formula (allowing ±20% noise from JSON structure overhead).
    expect(estimate).toBeGreaterThan((bytes / 3.5) * 0.8);
    expect(estimate).toBeLessThan((bytes / 3.5) * 1.2);
  });

  it("no longer underestimates CJK-heavy payloads", () => {
    const content = "这是一段用于估算的中文内容,用来验证脚本能感知的估算。".repeat(20);
    const messages: Message[] = [{ role: "user", content }];
    const estimate = manager().estimateTokens(messages, []);
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools: [] }), "utf8");
    const cjkCharacters = (content.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g) ?? []).length;
    expect(cjkCharacters).toBeGreaterThan(100);
    // Old algorithm: bytes/3.5 systematically underestimates; the new one floors at 1 token per character.
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(bytes / 3.5));
    expect(estimate).toBeGreaterThanOrEqual(cjkCharacters);
  });

  it("corrects both offset and slope through the usage anchor", () => {
    const m = manager();
    const ascii: Message[] = [{ role: "user", content: "review the workspace and report findings".repeat(10) }];
    const anchorEstimate = m.estimateTokens(ascii, []);
    // Anchor with a usage matching the estimate: the same payload afterwards should return
    // exactly the anchor value.
    m.recordUsage({ input_tokens: anchorEstimate }, ascii, []);
    expect(m.estimateTokens(ascii, [])).toBe(anchorEstimate);

    // Append a lot of Chinese: the CJK increment uses the new slope and must exceed the old byte-slope increment.
    const grown: Message[] = [
      ...ascii,
      { role: "user", content: "补充一段很长的中文说明以推动上下文增长,验证锚点斜率修正生效。".repeat(10) },
    ];
    const newEstimate = m.estimateTokens(grown, []);
    const grownBytes = Buffer.byteLength(JSON.stringify({ messages: grown, tools: [] }), "utf8");
    const anchorBytes = Buffer.byteLength(JSON.stringify({ messages: ascii, tools: [] }), "utf8");
    const flatDelta = (grownBytes - anchorBytes) / 3.5;
    expect(newEstimate).toBeGreaterThan(anchorEstimate + flatDelta);
  });
});
