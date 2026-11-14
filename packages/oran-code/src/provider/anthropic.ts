import type {
  AnthropicReplayBlock,
  Message,
  ModelConfig,
  ModelProvider,
  ModelResponse,
  ModelStreamChunk,
  ProviderRequestOptions,
  ToolCall,
} from "../types.js";
import { estimatedPayloadTokens } from "../context/estimator.js";
import { isAnthropicReplayBlock, isTruncatedFinishReason } from "../types.js";
import { CLIENT_ID, CLIENT_USER_AGENT, PRODUCT_VERSION } from "../paths.js";
import { ModelRequestError, boundedError, retryAfterMsFromResponse, streamErrorToModelRequestError } from "./errors.js";
import { parseSseJson, readSseEvents } from "./sse.js";
import { appendTailReminder, completeRequestSignal } from "./common.js";
import {
  createStreamingRequest,
  modelResponseChunks,
  numericUsage,
  requestOptions,
  stringOption,
} from "./transport.js";

export class AnthropicProvider implements ModelProvider {
  private readonly endpoint: string;
  private readonly apiVersion: string;

  constructor(private readonly config: ModelConfig) {
    const base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.endpoint = base.endsWith("/messages") || base.endsWith("/v1/messages") ? base : `${base}/v1/messages`;
    this.apiVersion =
      stringOption(config.options, "anthropicVersion") ??
      stringOption(config.options, "anthropic-version") ??
      "2023-06-01";
  }

  async complete(
    messages: Message[],
    tools?: Record<string, unknown>[],
    options?: ProviderRequestOptions,
  ): Promise<ModelResponse> {
    const signal = completeRequestSignal(options);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.payload(messages, tools, false, options?.maxTokens)),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw new ModelRequestError(response.status, await boundedError(response), retryAfterMsFromResponse(response));
    const data = (await response.json()) as Record<string, unknown>;
    return parseAnthropicMessage(data, false);
  }

  async *streamResponse(
    messages: Message[],
    tools?: Record<string, unknown>[],
    options?: ProviderRequestOptions,
  ): AsyncGenerator<ModelStreamChunk> {
    const request = createStreamingRequest(options?.signal);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.payload(messages, tools, true, options?.maxTokens)),
        signal: request.signal,
      });
      if (!response.ok)
        throw new ModelRequestError(response.status, await boundedError(response), retryAfterMsFromResponse(response));
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream") || !response.body) {
        yield* modelResponseChunks(parseAnthropicMessage((await response.json()) as Record<string, unknown>, false));
        return;
      }

      const toolUses = new Map<number, { id?: string; name: string; arguments: string }>();
      const contentBlocks = new Map<number, Record<string, unknown>>();
      const closedBlocks = new Set<number>();
      let finishReason: string | undefined;
      let streamCompleted = false;
      let currentBlockIndex: number | undefined;
      let currentBlockType: string | undefined;

      for await (const event of readSseEvents(response.body as AsyncIterable<Uint8Array>, options?.idleTimeoutMs, () =>
        request.abort(),
      )) {
        const parsed = parseSseJson(event);
        if (!parsed) continue;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "message_start") {
          const message = parsed.message as Record<string, unknown> | undefined;
          const usage = numericUsage(message?.usage ?? parsed.usage);
          if (Object.keys(usage).length) yield { type: "usage", usage, streamed: true };
          continue;
        }
        if (type === "content_block_start") {
          currentBlockIndex = typeof parsed.index === "number" ? parsed.index : undefined;
          const block = (parsed.content_block ?? {}) as Record<string, unknown>;
          currentBlockType = typeof block.type === "string" ? block.type : undefined;
          if (currentBlockIndex === undefined || !Number.isInteger(currentBlockIndex) || currentBlockIndex < 0 || contentBlocks.has(currentBlockIndex)) {
            throw new Error("anthropic stream contains an invalid or duplicate content-block index");
          }
          contentBlocks.set(currentBlockIndex, structuredClone(block));
          if (currentBlockType === "text" && typeof block.text === "string" && block.text) {
            yield { type: "text_delta", text: block.text, streamed: true };
          } else if (currentBlockType === "thinking" && typeof block.thinking === "string" && block.thinking) {
            yield { type: "reasoning_delta", text: block.thinking, streamed: true };
          }
          if (currentBlockType === "tool_use" && currentBlockIndex !== undefined) {
            toolUses.set(currentBlockIndex, {
              ...(typeof block.id === "string" ? { id: block.id } : {}),
              name: typeof block.name === "string" ? block.name : "",
              arguments: "",
            });
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = typeof parsed.index === "number" ? parsed.index : currentBlockIndex;
          const delta = (parsed.delta ?? {}) as Record<string, unknown>;
          const deltaType = typeof delta.type === "string" ? delta.type : "";
          const block = index === undefined ? undefined : contentBlocks.get(index);
          if (!block || index === undefined || closedBlocks.has(index)) throw new Error("anthropic delta has no open content block");
          if (deltaType === "text_delta" || typeof delta.text === "string") {
            if (block.type !== "text" || typeof delta.text !== "string") {
              throw new Error("anthropic text delta does not match its content block");
            }
            const text = delta.text;
            block.text = `${typeof block.text === "string" ? block.text : ""}${text}`;
            if (text) yield { type: "text_delta", text, streamed: true };
          } else if (deltaType === "thinking_delta" || typeof delta.thinking === "string") {
            if (block.type !== "thinking" || typeof delta.thinking !== "string") {
              throw new Error("anthropic thinking delta does not match its content block");
            }
            const reasoning = delta.thinking;
            block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${reasoning}`;
            if (reasoning) yield { type: "reasoning_delta", text: reasoning, streamed: true };
          } else if (deltaType === "signature_delta" || typeof delta.signature === "string") {
            if (block.type !== "thinking" || typeof delta.signature !== "string") {
              throw new Error("anthropic signature delta does not match its content block");
            }
            // Signatures replace the block snapshot value; they are not text fragments.
            const signature = delta.signature;
            block.signature = signature;
            if (signature) yield { type: "reasoning_signature", signature, streamed: true };
          } else if (deltaType === "input_json_delta" || typeof delta.partial_json === "string") {
            const current = toolUses.get(index);
            if (block.type !== "tool_use" || !current || typeof delta.partial_json !== "string") {
              throw new Error("anthropic input delta does not match its tool-use block");
            }
            current.arguments += delta.partial_json;
          }
          continue;
        }
        if (type === "content_block_stop") {
          const index = typeof parsed.index === "number" ? parsed.index : currentBlockIndex;
          if (index === undefined || !contentBlocks.has(index) || closedBlocks.has(index)) {
            throw new Error("anthropic stop has no open content block");
          }
          closedBlocks.add(index);
          const call = toolUses.get(index);
          if (contentBlocks.get(index)?.type === "tool_use" && call) {
            yield {
              type: "tool_call_complete",
              toolCall: {
                index,
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                argumentsJson: call.arguments || JSON.stringify(contentBlocks.get(index)?.input ?? {}),
              },
              streamed: true,
            };
          }
          currentBlockIndex = undefined;
          currentBlockType = undefined;
          continue;
        }
        if (type === "message_delta") {
          const delta = (parsed.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === "string") finishReason = delta.stop_reason;
          const usage = numericUsage(parsed.usage);
          if (Object.keys(usage).length) yield { type: "usage", usage, streamed: true };
          continue;
        }
        if (type === "message_stop") {
          streamCompleted = true;
          break;
        }
        if (type === "error") {
          throw streamErrorToModelRequestError(parsed.error ?? parsed, "anthropic stream error");
        }
      }
      if (!streamCompleted) {
        throw new Error("anthropic stream ended without a message_stop event");
      }
      if (finishReason === undefined) throw new Error("anthropic stream ended without a stop_reason");
      const truncated = isTruncatedFinishReason(finishReason);
      if (!truncated && closedBlocks.size !== contentBlocks.size) throw new Error("anthropic stream ended with an open content block");
      if (!truncated) {
        const content = [...contentBlocks.entries()].sort(([left], [right]) => left - right).map(([index, block]) => {
          if (block.type !== "tool_use") return block;
          const call = toolUses.get(index)!;
          return { ...block, input: JSON.parse(call.arguments || JSON.stringify(block.input ?? {})) as unknown };
        });
        yield { type: "anthropic_content", content: replayContent(content), streamed: true };
      }
      yield {
        type: "response_complete", streamed: true, finishReason,
        ...(truncated ? { droppedToolCalls: [...toolUses.keys()].filter((index) => !closedBlocks.has(index)).length } : {}),
      };
    } finally {
      request.dispose();
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "user-agent": CLIENT_USER_AGENT,
      "x-oran-client": CLIENT_ID,
      "x-oran-version": PRODUCT_VERSION,
      "anthropic-version": this.apiVersion,
      ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
      ...this.config.headers,
    };
  }

  get maxOutputTokens(): number { return this.config.maxTokens; }

  estimateInputTokens(messages: readonly Message[], tools: readonly Record<string, unknown>[]): number {
    const { system, conversation } = toAnthropicMessages([...messages], cacheControlFor(this.config.options));
    return estimatedPayloadTokens({ system, messages: conversation, tools: tools.map(toAnthropicTool).filter(Boolean) });
  }

  private payload(
    messages: Message[],
    tools: Record<string, unknown>[] | undefined,
    stream: boolean,
    maxTokens?: number,
  ): Record<string, unknown> {
    const options = requestOptions(this.config.options);
    delete options.protocol;
    delete options.api;
    delete options.providerType;
    delete options.anthropicVersion;
    delete options["anthropic-version"];
    delete options.anthropicCacheTtl;
    const stableCacheControl = cacheControlFor(this.config.options);
    const { system, conversation } = toAnthropicMessages(messages, stableCacheControl);
    const anthropicTools = tools?.length ? tools.map(toAnthropicTool).filter(Boolean) : undefined;
    if (anthropicTools?.length) {
      const last = anthropicTools.length - 1;
      anthropicTools[last] = { ...anthropicTools[last], cache_control: stableCacheControl };
    }
    return {
      ...options,
      model: this.config.model,
      max_tokens: maxTokens ?? this.config.maxTokens,
      temperature: this.config.temperature,
      stream,
      ...(system ? { system } : {}),
      messages: conversation,
      ...(anthropicTools?.length ? { tools: anthropicTools, tool_choice: { type: "auto" } } : {}),
    };
  }
}

/**
 * Long-lived prefix breakpoints may opt into the 1h TTL (`options.anthropicCacheTtl: "1h"`) so a
 * long tool run or subagent wait does not let the cache expire. Per-turn breakpoints stay on the
 * default 5m TTL, since rewriting them at the long-TTL price would be wasteful.
 */
function cacheControlFor(options: Record<string, unknown> | undefined): Record<string, unknown> {
  return options?.anthropicCacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function toAnthropicTool(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  if (tool.type === "function" && tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)) {
    const fn = tool.function as Record<string, unknown>;
    if (typeof fn.name !== "string") return undefined;
    return {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema:
        fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} },
    };
  }
  if (typeof tool.name === "string") {
    return {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      input_schema:
        tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema)
          ? tool.input_schema
          : tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
            ? tool.parameters
            : { type: "object", properties: {} },
    };
  }
  return undefined;
}

function toAnthropicMessages(
  messages: Message[],
  stableCacheControl: Record<string, unknown>,
): {
  system: Record<string, unknown>[];
  conversation: Record<string, unknown>[];
} {
  const system: Record<string, unknown>[] = [];
  const conversation: Record<string, unknown>[] = [];
  const tailReminders: string[] = [];
  const userMessageIndices: number[] = [];
  let pendingToolResults: Record<string, unknown>[] = [];
  /**
   * Only the last cacheable system block gets a breakpoint: a breakpoint caches everything up to
   * and including its block, so marking both the stable prompt and the environment block would
   * spend two of the four allowed breakpoints on the same prefix and leave no room for the
   * per-conversation anchor.
   */
  let lastCacheableSystemBlock: Record<string, unknown> | undefined;

  const flushToolResults = (): void => {
    if (!pendingToolResults.length) return;
    conversation.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.metadata?.promptBlock === "runtime-reminder") {
        // Merge into the tail of the conversation so that per-turn changes do not
        // invalidate the stable prefix cache.
        const reminderText = message.content?.trim();
        if (reminderText) tailReminders.push(reminderText);
        continue;
      }
      if (message.metadata?.promptBlock === "task-notification") {
        // Keep notifications at their chronological position. Hoisting them into the top-level
        // system array would rewrite the cached system prefix every time a subagent reports.
        flushToolResults();
        const notificationText = message.content?.trim();
        if (notificationText) conversation.push({ role: "user", content: [{ type: "text", text: notificationText }] });
        continue;
      }
      if (message.content?.trim()) {
        const block: Record<string, unknown> = { type: "text", text: message.content.trim() };
        system.push(block);
        if (message.metadata?.cacheControl === "ephemeral") lastCacheableSystemBlock = block;
      }
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        // Use the same id fallback scheme as the assistant-side tool_use, otherwise the
        // pair fails to match and the API returns 400.
        tool_use_id: message.toolCallId ?? `call_${message.name ?? "unknown"}`,
        content: message.content ?? "",
        is_error: message.toolResultError === true || message.metadata?.repaired === true,
      });
      continue;
    }
    flushToolResults();
    if (message.role === "user") {
      userMessageIndices.push(conversation.length);
      conversation.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "assistant") {
      const content: Record<string, unknown>[] = [];
      if (message.anthropicContent !== undefined) {
        const replay = replayContent(message.anthropicContent);
        const replayCalls = replay.filter((block) => block.type === "tool_use");
        const calls = message.toolCalls ?? [];
        if (replayCalls.length !== calls.length || replayCalls.some((block, index) => {
          const call = calls[index]!;
          return block.id !== (call.id ?? `call_${call.name}`) || block.name !== call.name || JSON.stringify(block.input) !== JSON.stringify(call.arguments);
        })) throw new Error("Anthropic replay content no longer matches tool calls");
        if (replay.length) conversation.push({ role: "assistant", content: replay });
        continue;
      }
      // Legacy sessions retain a single signed thinking block when no block snapshot exists.
      if (message.reasoning && message.reasoningSignature) {
        content.push({ type: "thinking", thinking: message.reasoning, signature: message.reasoningSignature });
      }
      if (message.content?.trim()) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id ?? `call_${call.name}`,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      // An assistant message with empty content and no toolCalls is rejected by the API as an
      // empty text block (400, not retryable), so skip it outright.
      if (!content.length) continue;
      conversation.push({ role: "assistant", content });
    }
  }
  flushToolResults();
  if (lastCacheableSystemBlock) lastCacheableSystemBlock.cache_control = stableCacheControl;
  if (tailReminders.length) appendTailReminder(conversation, tailReminders.join("\n\n"));
  // For long conversations, place a stable breakpoint on the second-to-last user message: the
  // trailing breakpoint is invalidated every turn, whereas this one keeps the prefix before the
  // previous turn reusable. An Anthropic request allows at most 4 cache_control entries:
  // system blocks + 1 for tools + this stable breakpoint + the trailing breakpoint. Beyond that,
  // skip it.
  const existingBreakpoints = system.filter((block) => block.cache_control).length + 1;
  if (userMessageIndices.length >= 2 && conversation.length > 12 && existingBreakpoints + 2 <= 4) {
    const anchor = conversation[userMessageIndices[userMessageIndices.length - 2]!];
    if (anchor && typeof anchor.content === "string" && anchor.content) {
      anchor.content = [{ type: "text", text: anchor.content, cache_control: { type: "ephemeral" } }];
    }
  }
  if (conversation.length) {
    const last = conversation[conversation.length - 1]!;
    if (Array.isArray(last.content) && last.content.length) {
      const lastBlock = last.content[last.content.length - 1] as Record<string, unknown>;
      if (!lastBlock.cache_control) lastBlock.cache_control = { type: "ephemeral" };
    } else if (typeof last.content === "string") {
      last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    }
  }
  return { system, conversation };
}

function replayContent(content: unknown[]): AnthropicReplayBlock[] {
  return content.map((block) => {
    if (!isAnthropicReplayBlock(block)) throw new Error("unsupported or incomplete Anthropic replay content block");
    // Keep block-local signatures, opaque redactions, ordering and any provider metadata intact.
    return structuredClone(block);
  });
}

function parseAnthropicMessage(data: Record<string, unknown>, streamed: boolean): ModelResponse {
  const content = Array.isArray(data.content) ? data.content : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  let reasoningSignature: string | undefined;
  const toolCalls: ToolCall[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const block = raw as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") textParts.push(block.text);
    else if ((type === "thinking" || type === "reasoning") && typeof block.thinking === "string") {
      reasoningParts.push(block.thinking);
      if (typeof block.signature === "string" && block.signature) reasoningSignature = block.signature;
    } else if (type === "tool_use") {
      const input = block.input;
      const argumentsValue =
        input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      toolCalls.push({
        ...(typeof block.id === "string" ? { id: block.id } : {}),
        name: typeof block.name === "string" ? block.name : "unknown",
        arguments: argumentsValue,
        createdAt: new Date().toISOString(),
      });
    }
  }
  const usage = numericUsage(data.usage);
  const finishReason = typeof data.stop_reason === "string" ? data.stop_reason : undefined;
  // In a response truncated by max_tokens the tool_use input may be incomplete: drop it
  // entirely and mark the response as truncated.
  const truncated = isTruncatedFinishReason(finishReason);
  return {
    text: textParts.join(""),
    ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
    ...(!truncated && reasoningSignature ? { reasoningSignature } : {}),
    ...(!truncated ? { anthropicContent: replayContent(content) } : {}),
    toolCalls: truncated ? [] : toolCalls,
    raw: data,
    usage,
    streamed,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(truncated && toolCalls.length ? { truncatedToolCalls: toolCalls.length } : {}),
  };
}
