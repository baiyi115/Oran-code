import type { Message, ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk, ProviderRequestOptions, ToolCall } from "./types.js";
import { CLIENT_ID, CLIENT_USER_AGENT, PRODUCT_VERSION } from "./paths.js";

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly endpoint: string;

  constructor(private readonly config: ModelConfig) {
    const base = config.baseUrl ?? "https://api.openai.com/v1";
    this.endpoint = base.replace(/\/$/, "").endsWith("/chat/completions")
      ? base.replace(/\/$/, "")
      : `${base.replace(/\/$/, "")}/chat/completions`;
  }

  async complete(messages: Message[], tools?: Record<string, unknown>[], options?: ProviderRequestOptions): Promise<ModelResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.payload(messages, tools, false)),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new ModelRequestError(response.status, await boundedError(response));
    const data = await response.json() as Record<string, unknown>;
    return parseCompletion(data, false);
  }

  async *streamResponse(messages: Message[], tools?: Record<string, unknown>[], options?: ProviderRequestOptions): AsyncGenerator<ModelStreamChunk> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.payload(messages, tools, true)),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new ModelRequestError(response.status, await boundedError(response));
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      yield* modelResponseChunks(parseCompletion(await response.json() as Record<string, unknown>, false));
      return;
    }
    const state: OpenAiStreamState = {
      calls: new Map<number, { id?: string; name: string; arguments: string }>(),
    };
    for await (const event of readSseEvents(response.body as AsyncIterable<Uint8Array>)) {
      for (const update of parseOpenAiStreamEvent(event, state)) yield update;
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "user-agent": CLIENT_USER_AGENT,
      "x-oran-client": CLIENT_ID,
      "x-oran-version": PRODUCT_VERSION,
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
    };
  }

  private payload(messages: Message[], tools: Record<string, unknown>[] | undefined, stream: boolean): Record<string, unknown> {
    const options = requestOptions(this.config.options);
    if (this.config.reasoningEffort !== undefined) options.reasoning_effort = this.config.reasoningEffort;
    if (stream) {
      const configured = options.stream_options;
      options.stream_options = {
        ...(configured && typeof configured === "object" && !Array.isArray(configured) ? configured as Record<string, unknown> : {}),
        include_usage: true,
      };
    }
    return {
      ...options,
      model: this.config.model,
      messages: toOpenAiMessages(messages),
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    };
  }
}

interface OpenAiStreamState {
  readonly calls: Map<number, { id?: string; name: string; arguments: string }>;
}

function parseOpenAiStreamEvent(event: string, state: OpenAiStreamState): ModelStreamChunk[] {
  const parsed = parseSseJson(event);
  if (!parsed) return [];
  if (parsed.error !== undefined) throw new Error(streamErrorMessage(parsed.error, "OpenAI-compatible stream error"));
  const updates: ModelStreamChunk[] = [];
  const usage = numericUsage(parsed.usage);
  if (Object.keys(usage).length) updates.push({ type: "usage", usage, streamed: true });

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const reasoning = reasoningText(delta);
  if (reasoning) updates.push({ type: "reasoning_delta", text: reasoning, streamed: true });
  if (typeof delta?.content === "string" && delta.content) {
    updates.push({ type: "text_delta", text: delta.content, streamed: true });
  }

  const rawCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  for (const raw of rawCalls) {
    const call = raw as Record<string, unknown>;
    const index = typeof call.index === "number" ? call.index : 0;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const current = state.calls.get(index) ?? { name: "", arguments: "" };
    // Some compatible providers resend the full function name on every delta;
    // overwrite (not append) so repeated names do not concatenate.
    if (typeof fn.name === "string" && fn.name) current.name = fn.name;
    if (typeof call.id === "string") current.id = call.id;
    if (typeof fn.arguments === "string") current.arguments += fn.arguments;
    state.calls.set(index, current);
  }
  if (typeof choice?.finish_reason === "string") {
    const finishReason = choice.finish_reason;
    if (finishReason === "tool_calls") {
      for (const [index, call] of [...state.calls.entries()].sort(([left], [right]) => left - right)) {
        updates.push({
          type: "tool_call_complete",
          toolCall: {
            index,
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            argumentsJson: call.arguments || "{}",
          },
          streamed: true,
        });
      }
    }
    updates.push({ type: "response_complete", streamed: true, finishReason });
  }
  return updates;
}

async function* readSseEvents(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      if (event.trim()) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

function parseSseJson(event: string): Record<string, unknown> | undefined {
  const dataLines: string[] = [];
  for (const line of event.split(/\r\n|\r|\n/)) {
    if (line === "data") {
      dataLines.push("");
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) return undefined;
  const data = dataLines.join("\n");
  if (!data.trim() || data.trim() === "[DONE]") return undefined;
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid SSE JSON payload: expected an object");
  }
  return parsed as Record<string, unknown>;
}

function streamErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

/**
 * Model profiles may contain provider-specific request fields. Keep those
 * fields extensible, but never let connection or Oran-only settings leak
 * into the remote API request or override the canonical payload fields.
 */
function requestOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
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

export class ModelRequestError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`model API returned ${status}: ${detail}`);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

async function boundedError(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}

/** 运行时提醒移到对话末尾，避免逐轮变化击穿稳定前缀缓存。 */
function toOpenAiMessages(messages: readonly Message[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.metadata?.promptBlock === "runtime-reminder") {
      const reminderText = message.content?.trim() ?? "";
      if (!reminderText) continue;
      const last = result[result.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = `${last.content}\n\n${reminderText}`;
      } else {
        result.push({ role: "user", content: reminderText });
      }
      continue;
    }
    result.push(toApiMessage(message));
  }
  return result;
}

function toApiMessage(message: Message): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.role === "assistant" && message.toolCalls?.length && !message.content
      ? null
      : message.content ?? "",
  };
  if (message.toolCallId) result.tool_call_id = message.toolCallId;
  if (message.name) result.name = message.name;
  if (message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id ?? `call_${call.name}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return result;
}

function parseCompletion(data: Record<string, unknown>, streamed: boolean): ModelResponse {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((item) => parseToolCall(item as Record<string, unknown>))
    : [];
  const usage = numericUsage(data.usage);
  return {
    text: typeof message.content === "string" ? message.content : "",
    ...(reasoningText(message) ? { reasoning: reasoningText(message) } : {}),
    toolCalls,
    raw: data,
    usage,
    streamed,
    ...(typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
  };
}

function numericUsage(value: unknown): Record<string, number> {
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

function reasoningText(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  for (const key of ["reasoning_content", "reasoning", "thinking", "thoughts", "analysis", "reasoning_details"]) {
    const text = reasoningValueText(value[key]);
    if (text) return text;
  }
  return "";
}

function reasoningValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(reasoningValueText).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";

  const block = value as Record<string, unknown>;
  for (const key of ["text", "content", "summary", "thinking", "reasoning_content", "reasoning"]) {
    const text = reasoningValueText(block[key]);
    if (text) return text;
  }
  return "";
}

function parseToolCall(raw: Record<string, unknown>): ToolCall {
  const fn = (raw.function ?? raw) as Record<string, unknown>;
  const rawArguments = typeof fn.arguments === "string" ? fn.arguments : "{}";
  let argumentsValue: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
    argumentsValue = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid tool-call arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    name: typeof fn.name === "string" ? fn.name : "unknown",
    arguments: argumentsValue,
    createdAt: new Date().toISOString(),
  };
}


/** Create a protocol adapter from model config without leaking protocol details upward. */
export function createModelProvider(config: ModelConfig): ModelProvider {
  const protocol = resolveProviderProtocol(config);
  if (protocol === "anthropic") return new AnthropicProvider(config);
  return new OpenAICompatibleProvider(config);
}

function* modelResponseChunks(response: ModelResponse): Generator<ModelStreamChunk> {
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

export type RemoteProviderProtocol = "openai" | "anthropic";

export interface RemoteModel {
  id: string;
  /** Context window in tokens when the remote catalog reports one. */
  contextWindow?: number;
}

/**
 * Fetch the model catalog from a provider's /models endpoint. Normalizes the
 * base URL (strips a trailing slash, keeps an existing /v1) and adapts the
 * request shape to the OpenAI-compatible vs Anthropic conventions.
 */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string | undefined,
  protocol: RemoteProviderProtocol,
): Promise<RemoteModel[]> {
  const base = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": CLIENT_USER_AGENT,
    "x-oran-client": CLIENT_ID,
    "x-oran-version": PRODUCT_VERSION,
  };
  if (apiKey) {
    if (protocol === "anthropic") headers["x-api-key"] = apiKey;
    else headers.authorization = `Bearer ${apiKey}`;
  }
  const endpoint = base.endsWith("/v1")
    ? `${base}/models`
    : `${base}/v1/models`;
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`model catalog request failed (${response.status} ${response.statusText})`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const data = Array.isArray(payload.data) ? payload.data : [];
  const models: RemoteModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) continue;
    const contextWindow = numberField((entry as Record<string, unknown>).max_input_tokens)
      ?? numberField((entry as Record<string, unknown>).context_window)
      ?? numberField((entry as Record<string, unknown>).context_length);
    models.push({ id, ...(contextWindow !== undefined ? { contextWindow } : {}) });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveProviderProtocol(config: ModelConfig): "openai" | "anthropic" {
  const explicit = stringOption(config.options, "protocol")
    ?? stringOption(config.options, "api")
    ?? stringOption(config.options, "providerType");
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (normalized.includes("anthropic") || normalized === "claude") return "anthropic";
    if (normalized.includes("openai") || normalized.includes("compatible")) return "openai";
  }
  const providerName = config.provider.toLowerCase();
  if (providerName.includes("anthropic") || providerName.includes("claude")) return "anthropic";
  const base = (config.baseUrl ?? "").toLowerCase();
  if (base.includes("anthropic") || base.includes("claude")) return "anthropic";
  return "openai";
}

export class AnthropicProvider implements ModelProvider {
  private readonly endpoint: string;
  private readonly apiVersion: string;

  constructor(private readonly config: ModelConfig) {
    const base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.endpoint = base.endsWith("/messages") || base.endsWith("/v1/messages")
      ? base
      : `${base}/v1/messages`;
    this.apiVersion = stringOption(config.options, "anthropicVersion")
      ?? stringOption(config.options, "anthropic-version")
      ?? "2023-06-01";
  }

  async complete(messages: Message[], tools?: Record<string, unknown>[], options?: ProviderRequestOptions): Promise<ModelResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.payload(messages, tools, false)),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new ModelRequestError(response.status, await boundedError(response));
    const data = await response.json() as Record<string, unknown>;
    return parseAnthropicMessage(data, false);
  }

  async *streamResponse(messages: Message[], tools?: Record<string, unknown>[], options?: ProviderRequestOptions): AsyncGenerator<ModelStreamChunk> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.payload(messages, tools, true)),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new ModelRequestError(response.status, await boundedError(response));
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      yield* modelResponseChunks(parseAnthropicMessage(await response.json() as Record<string, unknown>, false));
      return;
    }

    const toolUses = new Map<number, { id?: string; name: string; arguments: string }>();
    let finishReason: string | undefined;
    let currentBlockIndex: number | undefined;
    let currentBlockType: string | undefined;

    for await (const event of readSseEvents(response.body as AsyncIterable<Uint8Array>)) {
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
          yield { type: "response_complete", streamed: true, ...(finishReason !== undefined ? { finishReason } : {}) };
          continue;
        }
        if (type === "error") {
          throw new Error(streamErrorMessage(parsed.error ?? parsed, "anthropic stream error"));
        }
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

  private payload(messages: Message[], tools: Record<string, unknown>[] | undefined, stream: boolean): Record<string, unknown> {
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

function stringOption(options: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toAnthropicTool(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  if (tool.type === "function" && tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)) {
    const fn = tool.function as Record<string, unknown>;
    if (typeof fn.name !== "string") return undefined;
    return {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters))
        ? fn.parameters
        : { type: "object", properties: {} },
    };
  }
  if (typeof tool.name === "string") {
    return {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      input_schema: (tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema))
        ? tool.input_schema
        : (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
          ? tool.parameters
          : { type: "object", properties: {} },
    };
  }
  return undefined;
}

function toAnthropicMessages(messages: Message[]): { system: Record<string, unknown>[]; conversation: Record<string, unknown>[] } {
  const system: Record<string, unknown>[] = [];
  const conversation: Record<string, unknown>[] = [];
  const tailReminders: string[] = [];
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
        tool_use_id: message.toolCallId ?? `tool_${pendingToolResults.length}`,
        content: message.content ?? "",
        is_error: false,
      });
      continue;
    }
    flushToolResults();
    if (message.role === "user") {
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
      conversation.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: message.content ?? "" }] });
    }
  }
  flushToolResults();
  if (tailReminders.length) {
    const reminderText = tailReminders.join("\n\n");
    const last = conversation[conversation.length - 1];
    if (last && last.role === "user") {
      if (typeof last.content === "string") {
        last.content = `${last.content}\n\n${reminderText}`;
      } else if (Array.isArray(last.content)) {
        last.content.push({ type: "text", text: reminderText });
      }
    } else {
      conversation.push({ role: "user", content: reminderText });
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
    else if ((type === "thinking" || type === "reasoning") && typeof block.thinking === "string") reasoningParts.push(block.thinking);
    else if (type === "tool_use") {
      const input = block.input;
      const argumentsValue = input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
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
