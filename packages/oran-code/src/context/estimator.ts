import type { Message, ModelConfig } from "../types.js";
import { CONTEXT_LIMITS } from "./limits.js";

/**
 * provider 实报 usage 建立的锚点。
 * 后续估算以锚点为基准、用混合估算差值同时修正斜率与偏移。
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
    return (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0) + (output ?? 0);
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
  // CJK 字符按保守 token 系数独立计;其余字节沿用 3.5 字节/token。
  const cjkBytes = cjkCharacters * 3;
  const cjkTokens = cjkCharacters * CONTEXT_LIMITS.cjkTokensPerCharacter;
  const otherTokens = Math.max(0, bytes - cjkBytes) / CONTEXT_LIMITS.charactersPerToken;
  return Math.max(0, Math.ceil(cjkTokens + otherTokens));
}

const CJK_CHARACTER_PATTERN = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

/** 摘要长度校验用:判断文本是否含 CJK 字符(信息密度不同,阈值不同)。 */
export const HAS_CJK_PATTERN = /[\u2E80-\u9FFF\uF900-\uFAFF]/;
