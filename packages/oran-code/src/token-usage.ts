export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function normalizeTokenUsage(usage: Record<string, number>): TokenUsage {
  const reportedInput = numberFrom(usage, "input_tokens", "prompt_tokens", "inputTokens");
  const outputTokens = numberFrom(usage, "output_tokens", "completion_tokens", "outputTokens") ?? 0;
  const reportedTotal = numberFrom(usage, "total_tokens", "totalTokens");
  const cacheReadTokens = cacheNumberFrom(usage, "cache_read_input_tokens", "cache_read_tokens", "cached_tokens");
  const cacheWriteTokens = cacheNumberFrom(usage, "cache_creation_input_tokens", "cache_write_tokens");
  const inputTokens = reportedInput ?? (reportedTotal === undefined ? 0 : Math.max(0, reportedTotal - outputTokens));
  // Matches the usageTotal convention in context-manager: with no explicit total, cache reads
  // and writes count too, otherwise the token budget is systematically underestimated once
  // prompt caching is enabled. For OpenAI-style fields (prompt/completion) cached_tokens is a
  // subset of prompt_tokens and must not be added into the total; for Anthropic-style fields
  // cache_read and input_tokens are disjoint, so adding them normally is correct.
  const isOpenAiShape = usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined;
  const totalTokens =
    reportedTotal ??
    inputTokens + outputTokens + (isOpenAiShape ? cacheWriteTokens : cacheReadTokens + cacheWriteTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function cacheNumberFrom(value: Record<string, number>, ...keys: string[]): number {
  return numberFrom(value, ...keys) ?? 0;
}

function numberFrom(value: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return Math.trunc(candidate);
  }
  return undefined;
}
