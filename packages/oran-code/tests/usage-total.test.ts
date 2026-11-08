import { describe, expect, it } from "vitest";
import { usageTotal } from "../src/context/estimator.js";
import { normalizeTokenUsage } from "../src/token-usage.js";

describe("normalizeTokenUsage", () => {
  it("reads DeepSeek's native prompt-cache counters", () => {
    // Some OpenAI-compatible endpoints return only the native hit/miss fields; ignoring them
    // reported a 0% cache hit rate even though the provider cached most of the prompt.
    const usage = normalizeTokenUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    });
    expect(usage.cacheReadTokens).toBe(800);
    expect(usage.inputTokens).toBe(1_000);
    expect(usage.totalTokens).toBe(1_050);
  });

  it("prefers explicit cache fields over the DeepSeek alias", () => {
    const usage = normalizeTokenUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      cache_read_input_tokens: 600,
      prompt_cache_hit_tokens: 800,
    });
    expect(usage.cacheReadTokens).toBe(600);
  });
});

describe("usage totals", () => {
  it("adds the cache fields only when the provider reports them separately", () => {
    // OpenAI-shaped usage: prompt_tokens already includes the cached tokens, so
    // adding cached_tokens on top inflated the context anchor — and every estimate
    // derived from it — by the cache-hit count.
    expect(usageTotal({ prompt_tokens: 60_000, completion_tokens: 100, cached_tokens: 55_000 })).toBe(60_100);
    // Anthropic-shaped usage: input_tokens and the cache fields are disjoint.
    expect(usageTotal({ input_tokens: 5_000, cache_read_input_tokens: 55_000, output_tokens: 100 })).toBe(60_100);
    expect(usageTotal({ input_tokens: 5_000, cache_creation_input_tokens: 1_000, output_tokens: 100 })).toBe(6_100);
  });

  it("falls back to the reported total only when the parts are absent", () => {
    expect(usageTotal({ total_tokens: 9_999 })).toBe(9_999);
    // The parts win when they are present: they are what the cache rule above needs.
    expect(usageTotal({ input_tokens: 5_000, output_tokens: 100, total_tokens: 9_999 })).toBe(5_100);
  });

  it("returns undefined when nothing recognisable was reported", () => {
    expect(usageTotal({})).toBeUndefined();
  });
});
