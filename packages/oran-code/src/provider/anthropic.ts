import type {
  Message,
  ModelConfig,
  ModelProvider,
  ModelResponse,
  ModelStreamChunk,
  ProviderRequestOptions,
  ToolCall,
} from "../types.js";
import { CLIENT_ID, CLIENT_USER_AGENT, PRODUCT_VERSION } from "../paths.js";
import { ModelRequestError, boundedError, retryAfterMsFromResponse, streamErrorMessage } from "./errors.js";
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
      body: JSON.stringify(this.payload(messages, tools, false)),
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
        body: JSON.stringify(this.payload(messages, tools, true)),
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
          if (deltaType === "text_delta" || typeof delta.text === "string") {
            const text = typeof delta.text === "string" ? delta.text : "";
            if (text) yield { type: "text_delta", text, streamed: true };
          } else if (deltaType === "thinking_delta" || typeof delta.thinking === "string") {
            const reasoning = typeof delta.thinking === "string" ? delta.thinking : "";
            if (reasoning) yield { type: "reasoning_delta", text: reasoning, streamed: true };
          } else if (deltaType === "input_json_delta" || typeof delta.partial_json === "string") {
            if (index === undefined) continue;
            const current = toolUses.get(index) ?? { name: "", arguments: "" };
            current.arguments += typeof delta.partial_json === "string" ? delta.partial_json : "";
            toolUses.set(index, current);
          }
          continue;
        }
        if (type === "content_block_stop") {
          const index = typeof parsed.index === "number" ? parsed.index : currentBlockIndex;
          const call = index === undefined ? undefined : toolUses.get(index);
          if (currentBlockType === "tool_use" && index !== undefined && call) {
            yield {
              type: "tool_call_complete",
              toolCall: {
                index,
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                argumentsJson: call.arguments || "{}",
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
          throw new Error(streamErrorMessage(parsed.error ?? parsed, "anthropic stream error"));
        }
      }
      if (!streamCompleted) {
        throw new Error("anthropic stream ended without a message_stop event");
      }
      yield { type: "response_complete", streamed: true, ...(finishReason !== undefined ? { finishReason } : {}) };
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

  private payload(
    messages: Message[],
    tools: Record<string, unknown>[] | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const options = requestOptions(this.config.options);
    delete options.protocol;
    delete options.api;
    delete options.providerType;
    delete options.anthropicVersion;
    delete options["anthropic-version"];
    const { system, conversation } = toAnthropicMessages(messages);
    const anthropicTools = tools?.length ? tools.map(toAnthropicTool).filter(Boolean) : undefined;
    if (anthropicTools?.length) {
      const last = anthropicTools.length - 1;
      anthropicTools[last] = { ...anthropicTools[last], cache_control: { type: "ephemeral" } };
    }
    return {
      ...options,
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream,
      ...(system ? { system } : {}),
      messages: conversation,
      ...(anthropicTools?.length ? { tools: anthropicTools, tool_choice: { type: "auto" } } : {}),
    };
  }
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

function toAnthropicMessages(messages: Message[]): {
  system: Record<string, unknown>[];
  conversation: Record<string, unknown>[];
} {
  const system: Record<string, unknown>[] = [];
  const conversation: Record<string, unknown>[] = [];
  const tailReminders: string[] = [];
  const userMessageIndices: number[] = [];
  let pendingToolResults: Record<string, unknown>[] = [];

  const flushToolResults = (): void => {
    if (!pendingToolResults.length) return;
    conversation.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.metadata?.promptBlock === "runtime-reminder") {
        // 合并到对话尾部，避免逐轮变化击穿稳定前缀缓存。
        const reminderText = message.content?.trim();
        if (reminderText) tailReminders.push(reminderText);
        continue;
      }
      if (message.content?.trim()) {
        system.push({
          type: "text",
          text: message.content.trim(),
          ...(message.metadata?.cacheControl === "ephemeral" ? { cache_control: { type: "ephemeral" } } : {}),
        });
      }
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        // 与 assistant 侧 tool_use 的 id fallback 保持同一方案,否则配不上对会 400。
        tool_use_id: message.toolCallId ?? `call_${message.name ?? "unknown"}`,
        content: message.content ?? "",
        is_error: false,
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
      if (message.content?.trim()) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id ?? `call_${call.name}`,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      // 空内容且无 toolCalls 的 assistant 消息会被 API 以空 text block 拒绝(400
      // 且不可重试),直接跳过。
      if (!content.length) continue;
      conversation.push({ role: "assistant", content });
    }
  }
  flushToolResults();
  if (tailReminders.length) appendTailReminder(conversation, tailReminders.join("\n\n"));
  // 长会话在倒数第二个 user 消息处加一个稳定断点:末尾断点每轮都会失效,
  // 这个断点让上一轮之前的前缀始终可复用。Anthropic 全请求最多 4 个
  // cache_control:system 块 + tools 1 个 + 稳定断点 + 末尾断点,超出即不加。
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

function parseAnthropicMessage(data: Record<string, unknown>, streamed: boolean): ModelResponse {
  const content = Array.isArray(data.content) ? data.content : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const block = raw as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") textParts.push(block.text);
    else if ((type === "thinking" || type === "reasoning") && typeof block.thinking === "string")
      reasoningParts.push(block.thinking);
    else if (type === "tool_use") {
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
  return {
    text: textParts.join(""),
    ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
    toolCalls,
    raw: data,
    usage,
    streamed,
    ...(typeof data.stop_reason === "string" ? { finishReason: data.stop_reason } : {}),
  };
}
