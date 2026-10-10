import type { Message, ModelConfig } from "../types.js";
import { CONTEXT_LIMITS } from "./limits.js";

/**
 * Anchor established from provider-reported usage.
 * Later estimates use the anchor as their baseline, and the hybrid-estimate delta corrects both
 * slope and offset.
 */
export interface UsageAnchor {
  tokens: number;
  contextEstimate: number;
}

export function resolveContextWindow(model: ModelConfig): number {
  if (Number.isInteger(model.contextWindow) && (model.contextWindow ?? 0) > 0) {
    return model.contextWindow!;
  }
  const protocolHints = [
    model.provider,
    model.baseUrl,
    model.options?.protocol,
    model.options?.api,
    model.options?.providerType,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return protocolHints.includes("anthropic") || protocolHints.includes("claude") ? 200_000 : 128_000;
}

export function usageTotal(usage: Record<string, number>): number | undefined {
  const value = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const candidate = usage[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.max(0, candidate);
    }
    return undefined;
  };
  const input = value("input_tokens", "prompt_tokens");
  const cacheRead = value("cache_read_tokens", "cache_read_input_tokens", "cached_tokens");
  const cacheCreation = value("cache_write_tokens", "cache_creation_input_tokens");
  const output = value("output_tokens", "completion_tokens");
  if ([input, cacheRead, cacheCreation, output].some((item) => item !== undefined)) {
    // OpenAI-style usage counts cached tokens inside prompt_tokens, so adding them
    // again inflated the total — and the anchor built from it, and every estimate
    // after that. Anthropic-style fields are disjoint, so they are added.
    // token-usage.ts draws the same distinction for the loop's accounting; this is
    // the same rule, kept in step with it.
    const openAiShape = value("prompt_tokens") !== undefined || value("completion_tokens") !== undefined;
    const cacheTotal = openAiShape ? (cacheCreation ?? 0) : (cacheRead ?? 0) + (cacheCreation ?? 0);
    return (input ?? 0) + (output ?? 0) + cacheTotal;
  }
  return value("total_tokens");
}

export function estimatedRequestTokens(
  messages: readonly Message[],
  tools: readonly Record<string, unknown>[],
): number {
  const payload = JSON.stringify({ messages, tools });
  const bytes = Buffer.byteLength(payload, "utf8");
  const cjkCharacters = payload.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
  // CJK characters are counted separately with a conservative tokens-per-character factor;
  // the remaining bytes keep the 3.5 bytes/token rule.
  const cjkBytes = cjkCharacters * 3;
  const cjkTokens = cjkCharacters * CONTEXT_LIMITS.cjkTokensPerCharacter;
  const otherTokens = Math.max(0, bytes - cjkBytes) / CONTEXT_LIMITS.charactersPerToken;
  return Math.max(0, Math.ceil(cjkTokens + otherTokens));
}

const CJK_CHARACTER_PATTERN = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

/**
 * Used by summary-length validation: whether the text contains CJK characters (different
 * information density, hence a different threshold).
 */
export const HAS_CJK_PATTERN = /[\u2E80-\u9FFF\uF900-\uFAFF]/;
