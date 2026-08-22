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
    // ASCII: 与旧公式同量级(允许 ±20% 的 JSON 结构开销扰动)。
    expect(estimate).toBeGreaterThan(bytes / 3.5 * 0.8);
    expect(estimate).toBeLessThan(bytes / 3.5 * 1.2);
  });

  it("no longer underestimates CJK-heavy payloads", () => {
    const content = "这是一段用于估算的中文内容,用来验证脚本能感知的估算。".repeat(20);
    const messages: Message[] = [{ role: "user", content }];
    const estimate = manager().estimateTokens(messages, []);
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools: [] }), "utf8");
    const cjkCharacters = (content.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g) ?? []).length;
    expect(cjkCharacters).toBeGreaterThan(100);
    // 旧算法:bytes/3.5 系统性低估;新算法至少按 1 token/字 保底。
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(bytes / 3.5));
    expect(estimate).toBeGreaterThanOrEqual(cjkCharacters);
  });

  it("corrects both offset and slope through the usage anchor", () => {
    const m = manager();
    const ascii: Message[] = [{ role: "user", content: "review the workspace and report findings".repeat(10) }];
    const anchorEstimate = m.estimateTokens(ascii, []);
    // 用与估算一致的 usage 建锚:后续同载荷应精确回归锚点值。
    m.recordUsage({ input_tokens: anchorEstimate }, ascii, []);
    expect(m.estimateTokens(ascii, [])).toBe(anchorEstimate);

    // 追加大量中文:CJK 增量按新斜率计,必须高于旧字节斜率的增量。
    const grown: Message[] = [...ascii, { role: "user", content: "补充一段很长的中文说明以推动上下文增长,验证锚点斜率修正生效。".repeat(10) }];
    const newEstimate = m.estimateTokens(grown, []);
    const grownBytes = Buffer.byteLength(JSON.stringify({ messages: grown, tools: [] }), "utf8");
    const anchorBytes = Buffer.byteLength(JSON.stringify({ messages: ascii, tools: [] }), "utf8");
    const flatDelta = (grownBytes - anchorBytes) / 3.5;
    expect(newEstimate).toBeGreaterThan(anchorEstimate + flatDelta);
  });
});
