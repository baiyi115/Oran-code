import type {
  Message,
  ModelConfig,
  ModelProvider,
  ModelResponse,
  ModelStreamChunk,
  ProviderRequestOptions,
  ToolCall,
} from "../types.js";
import { isTruncatedFinishReason } from "../types.js";
import { CLIENT_ID, CLIENT_USER_AGENT, PRODUCT_VERSION } from "../paths.js";
import { ModelRequestError, boundedError, retryAfterMsFromResponse, streamErrorToModelRequestError } from "./errors.js";
import { parseSseJson, readSseEvents } from "./sse.js";
import { createStreamingRequest, modelResponseChunks, numericUsage, requestOptions } from "./transport.js";
import { appendTailReminder, completeRequestSignal } from "./common.js";

/**
 * Error text returned when an endpoint explicitly rejects the reasoning_effort parameter (e.g.
 * "Unrecognized request argument: reasoning_effort"). Both "reasoning" and "effort" must appear
 * together, so that unrelated 400s, such as ones about reasoning_content, are not misclassified.
 */
const REASONING_EFFORT_REJECTED = /\breasoning[\s_-]?effort\b/i;
/**
 * A 400 is only taken as an echo demand when it mentions reasoning_content together with
 * a "must be sent back" requirement.
 */
const REASONING_CONTENT_MENTIONED = /reasoning_content/i;
const REASONING_ECHO_HINT = /pass(?:ed)?[ _]?back|required|must be|missing|expect(?:ed)?/i;

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly endpoint: string;
  /** Set once the endpoint returns 400 for reasoning_effort; later request bodies omit that parameter. */
  private reasoningBlocked = false;
  /** Set once the endpoint demands reasoning_content back; later request bodies include the historical reasoning. */
  private reasoningEcho = false;
  /**
   * Notifies the caller when the dropped-parameter fallback fires (so the conclusion can be
   * persisted); a failure does not affect the request itself.
   */
  onReasoningUnsupported?: () => void | Promise<void>;
  /**
   * Notifies the caller when the endpoint turns out to demand reasoning content back, so the
   * requirement can be remembered for the current process.
   */
  onReasoningEchoRequired?: () => void | Promise<void>;

  constructor(private readonly config: ModelConfig) {
    const base = config.baseUrl ?? "https://api.openai.com/v1";
    this.endpoint = base.replace(/\/$/, "").endsWith("/chat/completions")
      ? base.replace(/\/$/, "")
      : `${base.replace(/\/$/, "")}/chat/completions`;
  }

  /**
   * Send the request, giving each of the two self-healing 400s a single retry:
   * - endpoint rejects reasoning_effort → drop that parameter and resend (the conclusion is
   *   written into the user config, so later sessions stop sending it);
   * - endpoint demands reasoning_content back → resend with the historical reasoning (remembered
   *   only within the current process: this is a context requirement of this conversation, not
   *   a user setting, so it must not be persisted).
   * The two rules are mutually exclusive; any other 400 is thrown as-is.
   */
  private async postWithReasoningFallback(send: () => Promise<Response>): Promise<Response> {
    let response = await send();
    if (!response.ok) {
      const detail = await boundedError(response);
      if (response.status === 400 && this.sendsReasoningEffort() && REASONING_EFFORT_REJECTED.test(detail)) {
        await this.markReasoningUnsupported();
        response = await send();
      } else if (response.status === 400 && !this.echoesReasoning() && isReasoningEchoDemand(detail)) {
        await this.markReasoningEchoRequired();
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
    const signal = completeRequestSignal(options);
    const request = () =>
      fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.payload(messages, tools, false)),
        ...(signal ? { signal } : {}),
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
      // Some compatible implementations do not return finish_reason=tool_calls (or no
      // finish_reason at all); if calls accumulated without being emitted by the time the stream
      // ends, emit them all, rather than dropping them silently.
      // When the output was cut off by the limit, however, the arguments JSON is probably
      // incomplete and must not be emitted (parsing would fail and enter a pointless retry loop);
      // the truncation flag is handled upstream as an overall failure.
      if (!state.emittedCalls && state.calls.size && !isTruncatedFinishReason(state.finishReason)) {
        yield* openAiToolCallChunks(state);
      }
      // A missing finish_reason means a broken stream (a test locks in this contract); it is
      // treated as a failure upstream instead of synthesizing a default for the missing
      // terminal event.
      if (state.finishReason === undefined) {
        throw new Error("OpenAI-compatible stream ended without a finish_reason");
      }
      yield { type: "response_complete", streamed: true, finishReason: state.finishReason };
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

  /**
   * The endpoint demands reasoning content be echoed back (already remembered in config, or
   * just discovered in this session).
   */
  private echoesReasoning(): boolean {
    return this.reasoningEcho || this.config.reasoningEchoRequired === true;
  }

  private async markReasoningEchoRequired(): Promise<void> {
    this.reasoningEcho = true;
    await this.onReasoningEchoRequired?.();
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
      messages: toOpenAiMessages(messages, this.echoesReasoning()),
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    };
  }
}

/** Whether a 400 error text is demanding that reasoning_content be echoed back. */
function isReasoningEchoDemand(detail: string): boolean {
  return REASONING_CONTENT_MENTIONED.test(detail) && REASONING_ECHO_HINT.test(detail);
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
  if (parsed.error !== undefined) throw streamErrorToModelRequestError(parsed.error, "OpenAI-compatible stream error");
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

/** Move runtime reminders to the actual end of the conversation (matching the Anthropic path) so
 *  that per-turn reminder text does not rewrite history in place and break the stable prefix cache. */
function toOpenAiMessages(messages: readonly Message[], echoReasoningContent: boolean): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const tailReminders: string[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.metadata?.promptBlock === "runtime-reminder") {
      const reminderText = message.content?.trim() ?? "";
      if (reminderText) tailReminders.push(reminderText);
      continue;
    }
    result.push(toApiMessage(message, echoReasoningContent));
  }
  if (tailReminders.length) appendTailReminder(result, tailReminders.join("\n\n"));
  return result;
}

function toApiMessage(message: Message, echoReasoningContent: boolean): Record<string, unknown> {
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
  // Echo it back only when the endpoint explicitly demands it: strict endpoints 400 on unknown
  // parameters, so sending it by default is more fragile.
  if (echoReasoningContent && message.role === "assistant" && message.reasoning) {
    result.reasoning_content = message.reasoning;
  }
  return result;
}

function parseCompletion(data: Record<string, unknown>, streamed: boolean): ModelResponse {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  // Tool-call arguments in a truncated response may be incomplete (or the JSON may itself be
  // malformed enough to fail parsing), so drop them all and set the truncation flag; the caller
  // decides how to wrap up.
  const truncated = isTruncatedFinishReason(finishReason);
  const toolCalls =
    !truncated && Array.isArray(message.tool_calls)
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
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(truncated ? { truncated: true } : {}),
    // Report the count of dropped calls when truncated: callers use it to tell "text-only
    // truncation" apart from "truncated tool calls".
    ...(truncated && Array.isArray(message.tool_calls) && message.tool_calls.length
      ? { truncatedToolCalls: message.tool_calls.length }
      : {}),
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
