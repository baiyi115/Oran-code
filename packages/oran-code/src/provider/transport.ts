import type { ModelResponse, ModelStreamChunk } from "../types.js";

export interface StreamingRequest {
  readonly signal: AbortSignal;
  abort(): void;
  dispose(): void;
}

export function createStreamingRequest(sourceSignal?: AbortSignal): StreamingRequest {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (sourceSignal?.aborted) abort();
  else sourceSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    abort,
    dispose: () => sourceSignal?.removeEventListener("abort", abort),
  };
}

/**
 * Model profiles may contain provider-specific request fields. Keep those
 * fields extensible, but never let connection or Oran-only settings leak
 * into the remote API request or override the canonical payload fields.
 */
export function requestOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) return {};
  const reserved = new Set([
    "apiKey",
    "api_key",
    "headers",
    "baseUrl",
    "baseURL",
    "base_url",
    "permission",
    "model",
    "messages",
    "stream",
    "tools",
    "tool_choice",
    "temperature",
    "max_tokens",
    "maxTokens",
    "context_window",
    "contextWindow",
    "reasoningEffort",
    "reasoning_effort",
    "cache_control",
    "prompt_cache_options",
    "prompt_cache_key",
    "prompt_cache_retention",
  ]);
  return Object.fromEntries(
    Object.entries(options).filter(([key, value]) => !reserved.has(key) && value !== undefined),
  );
}

export function numericUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  // Flatten common nested cache/prompt-token detail objects into first-class counters.
  const details = source.prompt_tokens_details ?? source.input_tokens_details ?? source.cache_creation;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const nested = details as Record<string, unknown>;
    const cached = nested.cached_tokens ?? nested.cache_read_input_tokens;
    if (typeof cached === "number" && Number.isFinite(cached)) {
      result.cache_read_input_tokens = cached;
      result.cache_read_tokens = cached;
    }
    const created = nested.cache_creation_input_tokens ?? nested.cache_write_tokens;
    if (typeof created === "number" && Number.isFinite(created)) {
      result.cache_creation_input_tokens = created;
      result.cache_write_tokens = created;
    }
  }
  if (typeof source.cache_read_input_tokens === "number") result.cache_read_tokens = source.cache_read_input_tokens as number;
  if (typeof source.cache_creation_input_tokens === "number") result.cache_write_tokens = source.cache_creation_input_tokens as number;
  return result;
}

export function stringOption(options: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function* modelResponseChunks(response: ModelResponse): Generator<ModelStreamChunk> {
  if (response.reasoning) yield { type: "reasoning_delta", text: response.reasoning, streamed: response.streamed };
  if (response.text) yield { type: "text_delta", text: response.text, streamed: response.streamed };
  for (const [index, call] of response.toolCalls.entries()) {
    yield {
      type: "tool_call_complete",
      toolCall: {
        index,
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        argumentsJson: JSON.stringify(call.arguments),
      },
      streamed: response.streamed,
    };
  }
  if (Object.keys(response.usage).length) yield { type: "usage", usage: response.usage, streamed: response.streamed };
  yield {
    type: "response_complete",
    streamed: response.streamed,
    ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
  };
}
