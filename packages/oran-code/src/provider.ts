import type { Message, ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk, ProviderRequestOptions, ToolCall } from "./types.js";

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
    if (!response.ok) throw new Error(`model API returned ${response.status}: ${await boundedError(response)}`);
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
    if (!response.ok) throw new Error(`model API returned ${response.status}: ${await boundedError(response)}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      yield parseCompletion(await response.json() as Record<string, unknown>, false);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const text = { value: "" };
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    let finishReason: string | undefined;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const usage = numericUsage(parsed.usage);
        if (Object.keys(usage).length) yield { usage, streamed: true };
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = choices[0] as Record<string, unknown> | undefined;
        const delta = choice?.delta as Record<string, unknown> | undefined;
        const deltaReasoning = reasoningText(delta);
        if (deltaReasoning) yield { reasoning: deltaReasoning, streamed: true };
        const deltaText = typeof delta?.content === "string" ? delta.content : "";
        if (deltaText) {
          text.value += deltaText;
          yield { text: deltaText, streamed: true };
        }
        const rawCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
        for (const raw of rawCalls) {
          const call = raw as Record<string, unknown>;
          const index = typeof call.index === "number" ? call.index : 0;
          const fn = (call.function ?? {}) as Record<string, unknown>;
          const current = calls.get(index) ?? { name: "", arguments: "" };
          if (typeof call.id === "string") current.id = call.id;
          if (typeof fn.name === "string") current.name += fn.name;
          if (typeof fn.arguments === "string") current.arguments += fn.arguments;
          calls.set(index, current);
        }
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      }
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (data && data !== "[DONE]") {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const usage = numericUsage(parsed.usage);
        if (Object.keys(usage).length) yield { usage, streamed: true };
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = choices[0] as Record<string, unknown> | undefined;
        const delta = choice?.delta as Record<string, unknown> | undefined;
        const deltaReasoning = reasoningText(delta);
        if (deltaReasoning) yield { reasoning: deltaReasoning, streamed: true };
        const deltaText = typeof delta?.content === "string" ? delta.content : "";
        if (deltaText) {
          text.value += deltaText;
          yield { text: deltaText, streamed: true };
        }
        const rawCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
        for (const raw of rawCalls) {
          const call = raw as Record<string, unknown>;
          const index = typeof call.index === "number" ? call.index : 0;
          const fn = (call.function ?? {}) as Record<string, unknown>;
          const current = calls.get(index) ?? { name: "", arguments: "" };
          if (typeof call.id === "string") current.id = call.id;
          if (typeof fn.name === "string") current.name += fn.name;
          if (typeof fn.arguments === "string") current.arguments += fn.arguments;
          calls.set(index, current);
        }
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      }
    }
    const toolCalls = [...calls.values()].map((call) => parseToolCall(call));
    yield {
      text: "",
      toolCalls,
      streamed: true,
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
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
      messages: messages.map(toApiMessage),
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    };
  }
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

async function boundedError(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
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

function parseCompletion(data: Record<string, unknown>, streamed: boolean): ModelResponse & ModelStreamChunk {
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
    if (!response.ok) throw new Error(`model API returned ${response.status}: ${await boundedError(response)}`);
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
    if (!response.ok) throw new Error(`model API returned ${response.status}: ${await boundedError(response)}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      yield parseAnthropicMessage(await response.json() as Record<string, unknown>, false);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolUses = new Map<number, { id?: string; name: string; arguments: string }>();
    let finishReason: string | undefined;
    let currentBlockIndex: number | undefined;
    let currentBlockType: string | undefined;

    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "message_start") {
          const message = parsed.message as Record<string, unknown> | undefined;
          const usage = numericUsage(message?.usage ?? parsed.usage);
          if (Object.keys(usage).length) yield { usage, streamed: true };
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
            if (text) yield { text, streamed: true };
          } else if (deltaType === "thinking_delta" || typeof delta.thinking === "string") {
            const reasoning = typeof delta.thinking === "string" ? delta.thinking : "";
            if (reasoning) yield { reasoning, streamed: true };
          } else if (deltaType === "input_json_delta" || typeof delta.partial_json === "string") {
            if (index === undefined) continue;
            const current = toolUses.get(index) ?? { name: "", arguments: "" };
            current.arguments += typeof delta.partial_json === "string" ? delta.partial_json : "";
            toolUses.set(index, current);
          }
          continue;
        }
        if (type === "content_block_stop") {
          currentBlockIndex = undefined;
          currentBlockType = undefined;
          continue;
        }
        if (type === "message_delta") {
          const delta = (parsed.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === "string") finishReason = delta.stop_reason;
          const usage = numericUsage(parsed.usage);
          if (Object.keys(usage).length) yield { usage, streamed: true };
          continue;
        }
        if (type === "message_stop") {
          continue;
        }
        if (type === "error") {
          const error = (parsed.error ?? parsed) as Record<string, unknown>;
          const message = typeof error.message === "string" ? error.message : "anthropic stream error";
          throw new Error(message);
        }
      }
    }

    const toolCalls = [...toolUses.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => parseToolCall({
        ...(call.id ? { id: call.id } : {}),
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
    yield {
      text: "",
      toolCalls,
      streamed: true,
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "anthropic-version": this.apiVersion,
      ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
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
  let pendingToolResults: Record<string, unknown>[] = [];

  const flushToolResults = (): void => {
    if (!pendingToolResults.length) return;
    conversation.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
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
  return { system, conversation };
}

function parseAnthropicMessage(data: Record<string, unknown>, streamed: boolean): ModelResponse & ModelStreamChunk {
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
