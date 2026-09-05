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
  // 与 context-manager 的 usageTotal 口径一致:无显式 total 时把缓存读写
  // 也计入,否则开了 prompt cache 后 token budget 会系统性低估。
  // OpenAI 系字段(prompt/completion)的 cached_tokens 是 prompt_tokens 的子集,
  // 不得再加进 total;Anthropic 系的 cache_read 与 input_tokens 互斥,正常累加。
  const isOpenAiShape = usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined;
  const totalTokens = reportedTotal ?? inputTokens + outputTokens + (isOpenAiShape ? cacheWriteTokens : cacheReadTokens + cacheWriteTokens);

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
