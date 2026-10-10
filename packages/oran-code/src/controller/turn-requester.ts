import type { ContextManager } from "../context-manager.js";
import { isTruncatedFinishReason } from "../types.js";
import type {
  HookEventPortContext,
  Message,
  ModelProvider,
  ModelResponse,
  RuntimeConfig,
  RuntimeEventPayloads,
} from "../types.js";
import { repairToolMessagePairs } from "../message-utils.js";
import { ModelRequestError } from "../provider.js";
import { formatErrorMessage } from "../error-format.js";
import { isAbortError } from "../utils/abort-error.js";
import type { AgentLoop } from "../loop.js";
import {
  classifyModelRetry,
  EmptyModelResponseError,
  extractPlanText,
  fingerprintRequest,
  fingerprintResponse,
  isRetryableModelStatus,
  modelRetryDelayMs,
  normalizeCallId,
  parseCompletedToolCall,
  sameToolCall,
  summarizeMessageTail,
  summarizeToolCalls,
  sleepWithSignal,
  usageAnchorMessages,
  withRuntimeReminders,
} from "../controller-utils.js";

const BUDGET_COMPACTION_MIN_REQUEST_TOKENS = 32_000;
const BUDGET_COMPACTION_HEADROOM = 1.5;
const BUDGET_COMPACTION_GROWTH_FACTOR = 1.25;
const BUDGET_COMPACTION_COOLDOWN_TURNS = 3;

/**
 * Provider stream protocol contract violation (still emitting events after the response completed,
 * duplicate completion markers, etc.). Retrying the same response on a contract violation is
 * pointless, so streamWithRetry fails it immediately.
 */
export class ProviderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderContractError";
  }
}

/**
 * Port between the model request pipeline and TaskController. controller keeps events, hooks,
 * session sync and diagnostic channels; the requester handles context preparation, compaction
 * decisions and stream consumption.
 */
export interface TurnRequesterPorts {
  readonly config: RuntimeConfig;
  readonly provider: ModelProvider;
  readonly contextManager: ContextManager;
  readonly logger: (message: string) => void;
  readonly debugLogger: (message: string) => void;
  emit<K extends keyof RuntimeEventPayloads>(type: K, payload: RuntimeEventPayloads[K], turnId?: string): Promise<void>;
  fireHook(ctx: HookEventPortContext): Promise<void>;
  syncConversation(messages: readonly Message[]): void;
  appendDiagnosticStep(kind: string, payload: Record<string, unknown>): number | undefined;
  throwIfCancelled(): void;
  getAbortSignal(): AbortSignal | undefined;
  getActiveTaskId(): string | undefined;
  getHookUserPrompt(): string;
}

/**
 * Single-turn model request pipeline: context offload/compaction decision → retryable streaming call
 * → event stream consumption.
 * Per-task state such as turn counting and compaction cooldown is owned by this class. Extracted
 * from TaskController, behavior unchanged.
 */
export class TurnRequester {
  private turnSequence = 0;
  private modelResponseStepId: number | undefined;
  private lastContextCompactionTurn = Number.NEGATIVE_INFINITY;
  private contextCompactionFloorTokens = 0;

  constructor(private readonly ports: TurnRequesterPorts) {}

  resetForTask(): void {
    this.turnSequence = 0;
    this.modelResponseStepId = undefined;
    this.lastContextCompactionTurn = Number.NEGATIVE_INFINITY;
    this.contextCompactionFloorTokens = 0;
  }

  get currentTurnSequence(): number {
    return this.turnSequence;
  }

  get currentModelResponseStepId(): number | undefined {
    return this.modelResponseStepId;
  }

  async requestWithContext(
    messages: Message[],
    reminders: readonly string[],
    loop: AgentLoop,
    step: number,
    source: string,
    tools: Record<string, unknown>[],
  ): Promise<{ messages: Message[]; response: ModelResponse }> {
    let managedMessages = repairToolMessagePairs(await this.prepareContext(messages, reminders, tools, loop));
    this.ports.syncConversation(managedMessages);
    let requestMessages = withRuntimeReminders(managedMessages, reminders);
    await this.ports.fireHook({
      event: "before_model_request",
      workspace: this.ports.config.workspace,
      model: this.ports.config.model.model,
      userPrompt: this.ports.getHookUserPrompt(),
    });
    try {
      const response = await this.streamWithRetry(requestMessages, loop, step, source, tools);
      this.ports.contextManager.recordUsage(response.usage, usageAnchorMessages(requestMessages, response), tools);
      await this.ports.fireHook({
        event: "after_model_response",
        workspace: this.ports.config.workspace,
        model: this.ports.config.model.model,
        assistantText: response.text,
      });
      return { messages: managedMessages, response };
    } catch (error) {
      if (isAbortError(error) || this.ports.getAbortSignal()?.aborted) throw error;
      if (!this.ports.contextManager.isPromptTooLongError(error)) throw error;

      const contextWindow = this.ports.contextManager.resolveContextWindow(this.ports.config.model);
      const beforeTokens = this.ports.contextManager.estimateTokens(requestMessages, tools);
      await this.ports.emit("context_compaction", {
        phase: "started",
        reason: "emergency",
        beforeTokens,
        replacementCount: 0,
        message: "The provider rejected the request because the context window was exceeded. Compacting now.",
      });
      try {
        const compacted = await this.ports.contextManager.compact({
          messages: requestMessages,
          provider: this.ports.provider,
          tools,
          contextWindow,
          reason: "emergency",
          ...(this.ports.getAbortSignal() ? { signal: this.ports.getAbortSignal()! } : {}),
        });
        managedMessages = repairToolMessagePairs(compacted.messages);
        this.ports.syncConversation(managedMessages);
        await this.ports.emit("context_compaction", {
          phase: "completed",
          reason: "emergency",
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          replacementCount: compacted.replacementCount,
        });
      } catch (compactionError) {
        await this.ports.emit("context_compaction", {
          phase: "failed",
          reason: "emergency",
          beforeTokens,
          replacementCount: 0,
          message: formatErrorMessage(compactionError),
        });
        throw compactionError;
      }

      this.ports.throwIfCancelled();
      requestMessages = withRuntimeReminders(managedMessages, reminders);
      const response = await this.streamResponse(requestMessages, loop, step, source, 1, tools);
      this.ports.contextManager.recordUsage(response.usage, usageAnchorMessages(requestMessages, response), tools);
      return { messages: managedMessages, response };
    }
  }

  private async prepareContext(
    messages: Message[],
    reminders: readonly string[],
    tools: Record<string, unknown>[],
    loop: AgentLoop,
  ): Promise<Message[]> {
    let managedMessages = messages;
    const beforeOffload = this.ports.contextManager.estimateTokens(
      withRuntimeReminders(managedMessages, reminders),
      tools,
    );
    const offload = await this.ports.contextManager.offloadAndSnip(managedMessages);
    managedMessages = this.ports.contextManager.refreshRecoveryMessage(offload.messages, tools);
    if (offload.replacementCount > 0 || offload.failedCount > 0) {
      const afterOffload = this.ports.contextManager.estimateTokens(
        withRuntimeReminders(managedMessages, reminders),
        tools,
      );
      await this.ports.emit("context_compaction", {
        phase: "offloaded",
        reason: "auto",
        beforeTokens: beforeOffload,
        afterTokens: afterOffload,
        replacementCount: offload.replacementCount,
        ...(offload.failedCount > 0
          ? { message: `${offload.failedCount} tool result(s) could not be persisted and were kept in context.` }
          : {}),
      });
      this.ports.syncConversation(managedMessages);
    }

    const requestMessages = withRuntimeReminders(managedMessages, reminders);
    const contextWindow = this.ports.contextManager.resolveContextWindow(this.ports.config.model);
    const beforeTokens = this.ports.contextManager.estimateTokens(requestMessages, tools);
    const compactForContextWindow = this.ports.contextManager.shouldAutoCompact(requestMessages, contextWindow, tools);

    const tokenBudget = loop.config.tokenBudget;
    const remainingBudget = Math.max(0, tokenBudget - loop.tokensUsed);
    const remainingRequests = Math.max(1, loop.remainingTurns() + 1);
    const sustainableRequestTokens = remainingBudget / remainingRequests;
    const budgetCompactionThreshold = Math.max(
      BUDGET_COMPACTION_MIN_REQUEST_TOKENS,
      sustainableRequestTokens * BUDGET_COMPACTION_HEADROOM,
      this.contextCompactionFloorTokens * BUDGET_COMPACTION_GROWTH_FACTOR,
    );
    const compactForTokenBudget =
      tokenBudget > 0 &&
      remainingBudget > 0 &&
      loop.turns - this.lastContextCompactionTurn >= BUDGET_COMPACTION_COOLDOWN_TURNS &&
      beforeTokens >= budgetCompactionThreshold;
    if (!compactForContextWindow && !compactForTokenBudget) return managedMessages;

    const budgetMessage =
      compactForTokenBudget && !compactForContextWindow
        ? "Compacting early to keep the remaining model iterations within the task token budget."
        : undefined;
    this.lastContextCompactionTurn = loop.turns;
    await this.ports.emit("context_compaction", {
      phase: "started",
      reason: "auto",
      beforeTokens,
      replacementCount: 0,
      ...(budgetMessage ? { message: budgetMessage } : {}),
    });
    try {
      const compacted = await this.ports.contextManager.compact({
        messages: requestMessages,
        provider: this.ports.provider,
        tools,
        contextWindow,
        reason: "auto",
        ...(this.ports.getAbortSignal() ? { signal: this.ports.getAbortSignal()! } : {}),
      });
      managedMessages = compacted.messages;
      this.contextCompactionFloorTokens = Math.max(1, compacted.afterTokens);
      this.ports.syncConversation(managedMessages);
      await this.ports.emit("context_compaction", {
        phase: "completed",
        reason: "auto",
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
        replacementCount: compacted.replacementCount,
        ...(budgetMessage ? { message: budgetMessage } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || this.ports.getAbortSignal()?.aborted) throw error;
      const message = formatErrorMessage(error);
      await this.ports.emit("context_compaction", {
        phase: "failed",
        reason: "auto",
        beforeTokens,
        replacementCount: 0,
        message,
      });
      // The failure is already in the transcript as a context_compaction failed event; do not
      // repeat it with a system line.
    }
    return managedMessages;
  }

  private async streamWithRetry(
    messages: Message[],
    loop: AgentLoop,
    step: number,
    source: string,
    tools: Record<string, unknown>[],
  ): Promise<ModelResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.ports.config.loop.maxRetries; attempt += 1) {
      this.ports.throwIfCancelled();
      try {
        const response = await this.streamResponse(messages, loop, step, source, attempt, tools);
        // An empty response (which some compatible endpoints emit transiently) is treated as a
        // retryable error and takes part in the backoff loop, rather than failing the whole task
        // outright.
        if (!response.text.trim() && !response.toolCalls.length && !response.truncated) {
          throw new EmptyModelResponseError();
        }
        return response;
      } catch (error) {
        if (isAbortError(error) || this.ports.getAbortSignal()?.aborted) throw error;
        if (this.ports.contextManager.isPromptTooLongError(error)) throw error;
        if (error instanceof ModelRequestError && !isRetryableModelStatus(error.status)) throw error;
        if (error instanceof ProviderContractError) throw error;
        lastError = error;
        const message = formatErrorMessage(error);
        const category = classifyModelRetry(error);
        if (attempt >= this.ports.config.loop.maxRetries) {
          // Final failure is reported by the outer execute() error event.
          throw error;
        }
        // Surface the concrete failure immediately, then announce the retry.
        await this.ports.emit("retry", {
          step,
          source,
          attempt,
          nextAttempt: attempt + 1,
          maxRetries: this.ports.config.loop.maxRetries,
          message,
          category,
        });
        this.ports.appendDiagnosticStep("model_retry", {
          step,
          source,
          attempt,
          nextAttempt: attempt + 1,
          message,
          category,
        });
        const delayMs = modelRetryDelayMs(
          attempt,
          Math.random,
          error instanceof ModelRequestError ? error.retryAfterMs : undefined,
        );
        this.ports.debugLogger(
          JSON.stringify({
            event: "model_retry",
            taskId: this.ports.getActiveTaskId(),
            step,
            source,
            attempt,
            nextAttempt: attempt + 1,
            message,
            category,
            delayMs,
          }),
        );
        // Retries are already visible as retry events; the logger channel is reserved for
        // notifications "the model cannot see but the user should".
        await sleepWithSignal(delayMs, this.ports.getAbortSignal());
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async streamResponse(
    messages: Message[],
    loop: AgentLoop,
    step: number,
    source: string,
    attempt: number,
    tools: Record<string, unknown>[],
  ): Promise<ModelResponse> {
    const turnId = `turn-${++this.turnSequence}`;
    const startedAt = Date.now();
    this.modelResponseStepId = undefined;
    // Thought rows are model-adaptive: only open a thought bubble once the provider
    // actually streams reasoning. Many chat models never send reasoning at all.
    let thoughtStarted = false;
    await this.ports.emit("assistant_start", { step, source, attempt, model: this.ports.config.model.model }, turnId);
    const textParts: string[] = [];
    const completedToolCalls = new Map<number, import("../types.js").ToolCall>();
    let toolCallChunkCount = 0;
    const usage: Record<string, number> = {};
    const reasoningParts: string[] = [];
    /** Signature of an Anthropic thinking block, used only for replay on the next turn; produces no UI event. */
    const reasoningSignatures: string[] = [];
    let streamed = false;
    let finishReason: string | undefined;
    let responseCompleted = false;
    /** Truncated calls already dropped by the parse layer (as reported by the provider), summed with
     *  the requester's own fallback drop count. */
    let providerDroppedToolCalls = 0;
    try {
      const requestFingerprint = fingerprintRequest(messages);
      const estimatedRequestTokens = this.ports.contextManager.estimateTokens(messages, tools);
      this.ports.appendDiagnosticStep("model_request", {
        turnId,
        step,
        source,
        attempt,
        requestFingerprint,
        estimatedRequestTokens,
        taskTokensUsed: loop.tokensUsed,
        messageCount: messages.length,
        toolResultCount: messages.filter((message) => message.role === "tool").length,
      });
      this.ports.debugLogger(
        JSON.stringify({
          event: "model_request",
          taskId: this.ports.getActiveTaskId(),
          turnId,
          step,
          source,
          attempt,
          requestFingerprint,
          estimatedRequestTokens,
          taskTokensUsed: loop.tokensUsed,
          messageCount: messages.length,
          toolResultCount: messages.filter((message) => message.role === "tool").length,
          tail: summarizeMessageTail(messages),
        }),
      );
      const providerOptions = this.ports.getAbortSignal() ? { signal: this.ports.getAbortSignal()! } : undefined;
      const modelStartedAt = Date.now();
      for await (const chunk of this.ports.provider.streamResponse(messages, tools, providerOptions)) {
        streamed ||= chunk.streamed;
        if (responseCompleted) {
          throw new ProviderContractError(`provider emitted ${chunk.type} after response_complete`);
        }
        switch (chunk.type) {
          case "reasoning_delta":
            if (!thoughtStarted) {
              thoughtStarted = true;
              await this.ports.emit("thought_start", { step, source, attempt }, turnId);
            }
            reasoningParts.push(chunk.text);
            await this.ports.emit("thought_delta", { step, source, attempt, text: chunk.text }, turnId);
            break;
          case "reasoning_signature":
            reasoningSignatures.push(chunk.signature);
            break;
          case "text_delta":
            textParts.push(chunk.text);
            await this.ports.emit("assistant_delta", { step, source, attempt, text: chunk.text }, turnId);
            break;
          case "tool_call_complete": {
            const call = parseCompletedToolCall(chunk.toolCall);
            const existing = completedToolCalls.get(chunk.toolCall.index);
            if (existing && !sameToolCall(existing, call)) {
              throw new ProviderContractError(
                `provider emitted conflicting completed tool calls for index ${chunk.toolCall.index}`,
              );
            }
            if (!existing) {
              completedToolCalls.set(chunk.toolCall.index, call);
              toolCallChunkCount += 1;
            }
            break;
          }
          case "usage":
            Object.assign(usage, chunk.usage);
            break;
          case "response_complete":
            if (responseCompleted) throw new ProviderContractError("provider emitted response_complete more than once");
            responseCompleted = true;
            finishReason = chunk.finishReason;
            providerDroppedToolCalls = chunk.droppedToolCalls ?? 0;
            break;
        }
      }
      if (!responseCompleted)
        throw new ProviderContractError("provider stream ended without a response_complete event");
      loop.recordModelElapsed(Math.max(1, Date.now() - modelStartedAt));
      loop.recordUsage(usage);
      // Output-limit truncation: both text and tool calls may be incomplete. The endpoint can still
      // supply arguments that "parse", and executing them would add semantically incomplete side
      // effects, so every call in a truncated message is failed as a whole, and the truncation flag
      // is propagated up to controller to decide how to wrap up.
      const truncated = isTruncatedFinishReason(finishReason);
      let droppedTruncatedCalls = 0;
      if (truncated && completedToolCalls.size) {
        droppedTruncatedCalls = completedToolCalls.size;
        completedToolCalls.clear();
      }
      // Calls dropped by the parse layer also count toward the total: the caller uses that to tell a
      // pure-text truncation from a call truncation.
      droppedTruncatedCalls += providerDroppedToolCalls;
      const normalizedCalls = [...completedToolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => normalizeCallId(call, this.ports.contextManager));
      const response: ModelResponse = {
        text: textParts.join(""),
        ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
        ...(reasoningSignatures.length ? { reasoningSignature: reasoningSignatures.join("") } : {}),
        toolCalls: normalizedCalls,
        raw: { usage, finishReason, toolCalls: normalizedCalls, ...(truncated ? { truncated: true } : {}) },
        usage,
        streamed,
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(truncated && droppedTruncatedCalls ? { truncatedToolCalls: droppedTruncatedCalls } : {}),
      };
      if (droppedTruncatedCalls > 0) {
        this.ports.logger(
          `Model output was truncated (finish_reason: ${finishReason ?? "unknown"}); ` +
            `${droppedTruncatedCalls} tool call(s) from this message were discarded without running.`,
        );
      }
      this.modelResponseStepId = this.ports.appendDiagnosticStep("model_response", {
        turnId,
        step,
        source,
        attempt,
        toolCallChunkCount,
        toolCalls: summarizeToolCalls(normalizedCalls),
        responseFingerprint: fingerprintResponse(response),
        finishReason,
        truncated,
        droppedTruncatedCalls,
        usage,
        taskTokensUsed: loop.tokensUsed,
      });
      this.ports.debugLogger(
        JSON.stringify({
          event: "model_response",
          taskId: this.ports.getActiveTaskId(),
          turnId,
          step,
          source,
          attempt,
          toolCallChunkCount,
          toolCalls: summarizeToolCalls(normalizedCalls),
          responseFingerprint: fingerprintResponse(response),
          finishReason,
          truncated,
          droppedTruncatedCalls,
          usage,
          taskTokensUsed: loop.tokensUsed,
        }),
      );
      if (thoughtStarted) {
        await this.ports.emit(
          "thought_end",
          {
            step,
            source,
            attempt,
            text: response.reasoning ?? "",
            durationMs: Math.max(0, Date.now() - startedAt),
          },
          turnId,
        );
      }
      const displayText =
        this.ports.config.workMode === "plan" ? extractPlanText(response.text) || response.text : response.text;
      await this.ports.emit(
        "assistant_end",
        {
          step,
          source,
          attempt,
          text: displayText,
          toolCalls: response.toolCalls,
          usage,
          streamed: response.streamed,
          ...(finishReason !== undefined ? { finishReason } : {}),
        },
        turnId,
      );
      return response;
    } catch (error) {
      if (thoughtStarted) {
        await this.ports.emit(
          "thought_end",
          {
            step,
            source,
            attempt,
            text: reasoningParts.join(""),
            durationMs: Math.max(0, Date.now() - startedAt),
          },
          turnId,
        );
      }
      const aborted = isAbortError(error) || this.ports.getAbortSignal()?.aborted;
      // Usage already received before a mid-stream failure must be booked too, otherwise the token
      // budget would systematically under-count.
      loop.recordUsage(usage);
      // A non-cancellation model error is reported by the outer `error` event.
      // Emitting assistant_abort as well makes the TUI show the same failure
      // twice: once as a bracketed assistant suffix and once as an Error block.
      if (aborted) {
        await this.ports.emit(
          "assistant_abort",
          {
            step,
            source,
            attempt,
            message: formatErrorMessage(error),
            ...(finishReason !== undefined ? { finishReason } : {}),
            usage: { ...usage },
          },
          turnId,
        );
      }
      if (aborted && (textParts.length || completedToolCalls.size || reasoningParts.length)) {
        // Preserve partial assistant output so conversation history stays usable after cancel.
        // Tool execution is only safe after the full provider response completed.
        return {
          text: textParts.join(""),
          ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
          ...(reasoningSignatures.length ? { reasoningSignature: reasoningSignatures.join("") } : {}),
          toolCalls: [],
          raw: { usage, finishReason, toolCalls: [], aborted: true },
          usage,
          streamed,
          ...(finishReason !== undefined ? { finishReason } : {}),
        };
      }
      throw error;
    }
  }
}
