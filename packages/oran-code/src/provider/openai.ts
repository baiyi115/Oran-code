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
import { createStreamingRequest, modelResponseChunks, numericUsage, requestOptions } from "./transport.js";
import { appendTailReminder } from "./common.js";

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly endpoint: string;
  /** 端点对 reasoning_effort 返回 400 后置位,后续请求体不再携带该参数。 */
  private reasoningBlocked = false;
  /** 剥参回退发生时通知上层(用于持久化结论),失败不影响请求本身。 */
  onReasoningUnsupported?: () => void | Promise<void>;

  constructor(private readonly config: ModelConfig) {
    const base = config.baseUrl ?? "https://api.openai.com/v1";
    this.endpoint = base.replace(/\/$/, "").endsWith("/chat/completions")
      ? base.replace(/\/$/, "")
      : `${base.replace(/\/$/, "")}/chat/completions`;
  }

  /** 发出请求;400+reasoning 的剥参回退只做一次,其余错误原样抛出。 */
  private async postWithReasoningFallback(send: () => Promise<Response>): Promise<Response> {
    let response = await send();
    if (!response.ok) {
      const detail = await boundedError(response);
      if (response.status === 400 && this.sendsReasoningEffort() && /reasoning/i.test(detail)) {
        await this.markReasoningUnsupported();
        response = await send();
      } else {
        throw new ModelRequestError(response.status, detail, retryAfterMsFromResponse(response));
      }
    }
    if (!response.ok) {
      throw new ModelRequestError(response.status, await boundedError(response), retryAfterMsFromResponse(response));
    }
    return response;
  }

  async complete(
    messages: Message[],
    tools?: Record<string, unknown>[],
    options?: ProviderRequestOptions,
  ): Promise<ModelResponse> {
    const request = () =>
      fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.payload(messages, tools, false)),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    const response = await this.postWithReasoningFallback(request);
    const data = (await response.json()) as Record<string, unknown>;
    return parseCompletion(data, false);
  }

  async *streamResponse(
    messages: Message[],
    tools?: Record<string, unknown>[],
    options?: ProviderRequestOptions,
  ): AsyncGenerator<ModelStreamChunk> {
    const request = createStreamingRequest(options?.signal);
    try {
      const send = () =>
        fetch(this.endpoint, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(this.payload(messages, tools, true)),
          signal: request.signal,
        });
      const response = await this.postWithReasoningFallback(send);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream") || !response.body) {
        yield* modelResponseChunks(parseCompletion((await response.json()) as Record<string, unknown>, false));
        return;
      }
      const state: OpenAiStreamState = {
        calls: new Map<number, { id?: string; name: string; arguments: string }>(),
        emittedCalls: false,
      };
      for await (const event of readSseEvents(response.body as AsyncIterable<Uint8Array>, options?.idleTimeoutMs, () =>
        request.abort(),
      )) {
        for (const update of parseOpenAiStreamEvent(event, state)) yield update;
      }
      // 部分兼容实现不返回 finish_reason=tool_calls(或根本没有 finish_reason);
      // 流结束时若有累积未发射的工具调用,统一补发,避免静默丢弃。
      if (!state.emittedCalls && state.calls.size) {
        yield* openAiToolCallChunks(state);
      }
      // 兼容实现可能始终不发 finish_reason;工具调用已补发,这里按内容合成
      // 收尾事件,而不是把已经流出的增量整条作废。
      yield {
        type: "response_complete",
        streamed: true,
        finishReason: state.finishReason ?? (state.emittedCalls || state.calls.size ? "tool_calls" : "stop"),
      };
    } finally {
      request.dispose();
    }
  }

  private sendsReasoningEffort(): boolean {
    return (
      !this.reasoningBlocked &&
      this.config.reasoningEffortDisabled !== true &&
      this.config.reasoningEffort !== undefined
    );
  }

  private async markReasoningUnsupported(): Promise<void> {
    this.reasoningBlocked = true;
    await this.onReasoningUnsupported?.();
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

  private payload(
    messages: Message[],
    tools: Record<string, unknown>[] | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const options = requestOptions(this.config.options);
    if (this.sendsReasoningEffort()) options.reasoning_effort = this.config.reasoningEffort;
    if (stream) {
      const configured = options.stream_options;
      options.stream_options = {
        ...(configured && typeof configured === "object" && !Array.isArray(configured)
          ? (configured as Record<string, unknown>)
          : {}),
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
  emittedCalls: boolean;
  finishReason?: string;
}

function openAiToolCallChunks(state: OpenAiStreamState): ModelStreamChunk[] {
  const updates: ModelStreamChunk[] = [];
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
  return updates;
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
    state.finishReason = finishReason;
    if (finishReason === "tool_calls") {
      state.emittedCalls = true;
      updates.push(...openAiToolCallChunks(state));
    }
  }
  return updates;
}

/** 运行时提醒移到对话真正的末尾(与 Anthropic 路径一致),避免逐轮变化的
 *  揕醒文本就地改写历史消息而击穿稳定前缀缓存。 */
function toOpenAiMessages(messages: readonly Message[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const tailReminders: string[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.metadata?.promptBlock === "runtime-reminder") {
      const reminderText = message.content?.trim() ?? "";
      if (reminderText) tailReminders.push(reminderText);
      continue;
    }
    result.push(toApiMessage(message));
  }
  if (tailReminders.length) appendTailReminder(result, tailReminders.join("\n\n"));
  return result;
}

function toApiMessage(message: Message): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content:
      message.role === "assistant" && message.toolCalls?.length && !message.content ? null : (message.content ?? ""),
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
    throw new Error(`invalid tool-call arguments: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    name: typeof fn.name === "string" ? fn.name : "unknown",
    arguments: argumentsValue,
    createdAt: new Date().toISOString(),
  };
}
