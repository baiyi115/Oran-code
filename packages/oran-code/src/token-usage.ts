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
  const inputTokens = reportedInput
    ?? (reportedTotal === undefined ? 0 : Math.max(0, reportedTotal - outputTokens));
  const totalTokens = reportedTotal ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: numberFrom(
      usage,
      "cache_read_input_tokens",
      "cache_read_tokens",
      "cached_tokens",
      "cacheReadTokens",
    ) ?? 0,
    cacheWriteTokens: numberFrom(
      usage,
      "cache_creation_input_tokens",
      "cache_write_tokens",
      "cacheWriteTokens",
    ) ?? 0,
  };
}

function numberFrom(value: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return Math.trunc(candidate);
  }
  return undefined;
}
