import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { promisify } from "node:util";
import { AgentLoop, toolCallSignature, type NoProgressDiagnostic } from "./loop.js";
import { CONTEXT_LIMITS, ContextManager } from "./context-manager.js";
import { PermissionPolicy, structuredPermissionDenial, type ApprovalDecision } from "./security.js";
import { discoverWorkspace } from "./workspace.js";
import { Verifier } from "./verifier.js";
import type { TraceStore } from "./trace.js";
import type {
  ApprovalCallback,
  ApprovalResponse,
  Message,
  ModelProvider,
  ModelResponse,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventPayloads,
  Task,
  TaskPlanState,
  TaskPlanStep,
  ToolCall,
  ToolCallComplete,
  ToolDefinition,
  ToolKind,
  ToolResult,
  OptionalSystemPromptModules,
  HookEnginePort,
  HookEventPortContext,
} from "./types.js";
import { transitionTask } from "./types.js";
import { formatErrorMessage } from "./error-format.js";
import { repairToolMessagePairs } from "./message-utils.js";
import { ModelRequestError } from "./provider.js";
import { isCasualConversationPrompt } from "./prompt-intent.js";
import { PRODUCT_VERSION } from "./paths.js";
import { isMutatingToolName, isPlanModeTool, isWriteToolName, type ToolRegistry } from "./tools.js";
import type { SnapshotStorePort } from "./snapshot.js";
import {
  buildEnvironmentPrompt,
  assembleStableSystemPrompt,
  environmentSystemMessage,
  loopBudgetReminder,
  stableSystemMessage,
  systemReminderMessage,
  taskPlanReminder,
  taskModeReminder,
} from "./system-prompt.js";

export type RuntimeEventCallback = (event: RuntimeEvent) => void | Promise<void>;
export type RuntimeLogger = (message: string) => void;
export type ConversationCallback = (messages: readonly Message[]) => void;

export interface TaskControllerOptions {
  config: RuntimeConfig;
  provider: ModelProvider;
  registry: ToolRegistry;
  trace: TraceStore;
  verifier?: Verifier;
  permission?: PermissionPolicy;
  approvalCallback?: ApprovalCallback;
  eventCallback?: RuntimeEventCallback;
  conversationCallback?: ConversationCallback;
  logger?: RuntimeLogger;
  /** Detailed request/response diagnostics. Disabled by default. */
  debugLogger?: RuntimeLogger;
  conversation?: Message[];
  contextManager?: ContextManager;
  stablePromptModules?: OptionalSystemPromptModules;
  runtimeReminders?: () => readonly string[];
  toolFilter?: (tool: ToolDefinition) => boolean;
  /** Hook 引擎端口。缺省时不启用任何 Hook 事件。 */
  hookEngine?: HookEnginePort;
  /** 最近一条用户提示文本，供 Hook 条件/命令使用。 */
  hookUserPrompt?: string;
  /** 上一任务已执行的调用历史，用于跨任务延续的重复调用守卫。 */
  previousToolCalls?: ToolCall[];
  /** 上一任务只读工具的成功结果缓存，重复模型调用直接回填，不重复执行。 */
  previousReadonlyResults?: ReadonlyMap<string, ToolResult>;
  /** Optional per-session file checkpoint store used by /undo. */
  snapshotStore?: SnapshotStorePort;
  snapshotSessionId?: string;
}

/** Explicit plan-complete markers the model may emit to finish plan mode. */
const PLAN_COMPLETE_MARKERS = [
  "PLAN_COMPLETE",
  "<<PLAN_COMPLETE>>",
  "<plan_complete>",
  "</plan_complete>",
] as const;

const BUDGET_COMPACTION_MIN_REQUEST_TOKENS = 32_000;
const BUDGET_COMPACTION_HEADROOM = 1.5;
const BUDGET_COMPACTION_GROWTH_FACTOR = 1.25;
const BUDGET_COMPACTION_COOLDOWN_TURNS = 3;
const execFileAsync = promisify(execFile);

interface DeferredToolRecord {
  call: ToolCall;
  index: number;
  result: ToolResult;
  duration: number;
  executed: boolean;
}

export class TaskController {
  private readonly config: RuntimeConfig;
  private readonly provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly trace: TraceStore;
  private readonly verifier: Verifier;
  private readonly permission: PermissionPolicy;
  private readonly approvalCallback: ApprovalCallback;
  private readonly eventCallback: RuntimeEventCallback;
  private readonly conversationCallback: ConversationCallback;
  private readonly logger: RuntimeLogger;
  private readonly debugLogger: RuntimeLogger;
  private readonly contextManager: ContextManager;
  private readonly stablePromptModules: OptionalSystemPromptModules;
  private readonly runtimeReminders: () => readonly string[];
  private readonly toolFilter: (tool: ToolDefinition) => boolean;
  private readonly hookEngine: HookEnginePort | undefined;
  private hookUserPrompt: string;
  private readonly previousToolCalls: readonly ToolCall[];
  private readonly readonlyCache = new Map<string, ToolResult>();
  private readonly snapshotStore: SnapshotStorePort | undefined;
  private readonly snapshotSessionId: string | undefined;
  private loop: AgentLoop | undefined;
  private abortController: AbortController | undefined;
  private activeTask: Task | undefined;
  private sequence = 0;
  private turnSequence = 0;
  private taskStartedAt = 0;
  private modelResponseStepId: number | undefined;
  private lastContextCompactionTurn = Number.NEGATIVE_INFINITY;
  private contextCompactionFloorTokens = 0;
  private conversation: Message[];
  private deferredToolRecords: DeferredToolRecord[] | undefined;

  constructor(options: TaskControllerOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.registry = options.registry;
    this.trace = options.trace;
    this.verifier = options.verifier ?? new Verifier(options.config.workspace, options.config.loop.commandTimeout);
    this.permission = options.permission ?? new PermissionPolicy(options.config.permissions);
    this.permission.registerTools(options.registry.list());
    this.approvalCallback = options.approvalCallback ?? (async () => false);
    this.eventCallback = options.eventCallback ?? (() => undefined);
    this.conversationCallback = options.conversationCallback ?? (() => undefined);
    this.logger = options.logger ?? (() => undefined);
    this.debugLogger = options.debugLogger ?? (() => undefined);
    this.conversation = cloneMessages(options.conversation ?? []);
    this.contextManager = options.contextManager ?? new ContextManager({
      workspace: options.config.workspace,
      conversation: this.conversation,
    });
    this.stablePromptModules = { ...options.stablePromptModules };
    this.runtimeReminders = options.runtimeReminders ?? (() => []);
    this.toolFilter = options.toolFilter ?? (() => true);
    this.hookEngine = options.hookEngine;
    this.hookUserPrompt = options.hookUserPrompt ?? "";
    this.previousToolCalls = options.previousToolCalls ?? [];
    this.snapshotStore = options.snapshotStore;
    this.snapshotSessionId = options.snapshotSessionId;
    if (options.previousReadonlyResults) {
      for (const [key, value] of options.previousReadonlyResults) this.readonlyCache.set(key, value);
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  conversationSnapshot(): Message[] {
    return cloneMessages(this.conversation);
  }

  get toolCallHistory(): ToolCall[] {
    return this.loop?.toolCalls.slice() ?? [];
  }

  get readonlyResultSnapshot(): ReadonlyMap<string, ToolResult> {
    return new Map(this.readonlyCache);
  }

  async execute(task: Task): Promise<Task> {
    if (this.activeTask) throw new Error("task controller is already executing");
    this.activeTask = task;
    this.abortController = new AbortController();
    this.sequence = 0;
    this.turnSequence = 0;
    this.taskStartedAt = Date.now();
    this.modelResponseStepId = undefined;
    this.lastContextCompactionTurn = Number.NEGATIVE_INFINITY;
    this.contextCompactionFloorTokens = 0;
    const loop = new AgentLoop(this.config.loop, this.previousToolCalls);
    this.loop = loop;
    this.hookUserPrompt = task.prompt;
    await this.fireHook({ event: "session_start", workspace: task.workspace, model: this.config.model.model, userPrompt: task.prompt });
    try {
      return await this.executeTask(task, loop);
    } catch (error) {
      if (isAbortError(error) || this.abortController.signal.aborted) {
        transitionTask(task, "cancelled");
        await this.persist(task);
        await this.emit("cancelled", { message: "task cancelled" });
        return task;
      }
      if (task.state !== "completed" && task.state !== "cancelled" && task.state !== "paused") {
        transitionTask(task, "failed");
        await this.persist(task);
      }
      await this.emit("error", { message: formatErrorMessage(error) });
      throw error;
    } finally {
      // 会话结束：确保异常路径也能触发
      await this.fireHook({ event: "session_end", workspace: task.workspace, model: this.config.model.model });
      try {
        await this.snapshotStore?.finalize(task);
      } catch (error) {
        this.debugLogger(JSON.stringify({ event: "snapshot_finalize_failed", taskId: task.id, error: formatErrorMessage(error) }));
      }
      this.activeTask = undefined;
      this.abortController = undefined;
      this.loop = undefined;
    }
  }

  private async executeTask(task: Task, loop: AgentLoop): Promise<Task> {
    const planMode = this.config.workMode === "plan";
    const casualConversation = isCasualConversationPrompt(task.prompt);
    transitionTask(task, planMode ? "planning" : "executing");
    task.model = this.config.model.model;
    await this.persist(task);
    const turnConversation: Message[] = [
      ...cloneMessages(this.conversation),
      { role: "user", content: `User message:\n${task.prompt}` },
    ];
    this.syncConversation(turnConversation);
    const snapshot = casualConversation
      ? {
          root: resolve(task.workspace),
          projectFiles: {},
          topLevel: [],
          isGitRepo: false,
          recentFiles: [],
          summary: "",
        }
      : await discoverWorkspace(task.workspace);
    this.trace.appendStep(task.id, "context", { summary: snapshot.summary });
    let messages: Message[] = [
      stableSystemMessage(assembleStableSystemPrompt(this.stablePromptModules)),
      environmentSystemMessage(buildEnvironmentPrompt({
        workspace: task.workspace,
        model: this.config.model,
        snapshot,
        appVersion: PRODUCT_VERSION,
      })),
      ...turnConversation,
    ];
    this.syncConversation(messages);

    let workspaceMutated = false;
    while (loop.canContinue()) {
      this.throwIfCancelled();
      loop.recordTurn();
      const finalTurn = loop.isFinalTurn();
      const hookNotices = this.hookEngine ? this.hookEngine.drainNotices() : [];
      const noProgressWarning = loop.noProgressWarning();
      const reminders = [
        taskModeReminder(planMode, loop.turns),
        loopBudgetReminder(loop.remainingTurns(), finalTurn),
        ...this.runtimeReminders(),
        ...hookNotices.map((notice) => `[hook:${notice.event}] ${notice.text}`),
      ];
      if (task.planState && task.planState.steps.length > 0) {
        reminders.push(taskPlanReminder(task.planState));
      }
      if (noProgressWarning) {
        const { call, repeatCount, limit, reason, detail } = noProgressWarning;
        if (reason === "repeated_error") {
          reminders.push(
            `Heads up: the last ${repeatCount} tool call(s) failed with the same error signature: "${detail ?? ""}". ` +
              `Please analyze the root cause before attempting the same approach again.`,
          );
        } else if (reason === "readonly_stall") {
          reminders.push(
            `Heads up: ${detail ?? "prolonged read-only exploration without changes"}. ` +
              `If you have gathered enough context, start implementing changes or provide a final answer to the user.`,
          );
        } else {
          const argSummary = formatCallArguments(call.arguments);
          reminders.push(
            `Heads up: the previous ${repeatCount} call(s) to ${call.name}(${argSummary}) look identical. ` +
              `If this is not intentional, approach the task differently. Repeating ${limit} times will pause the task.`,
          );
        }
      }
      // 轮次开始：通知队列已并入本轮系统提醒后派发
      await this.fireHook({ event: "turn_start", workspace: task.workspace, model: this.config.model.model, userPrompt: task.prompt });
      try {
        const tools = finalTurn || casualConversation ? [] : this.toolSchemasForMode();
        const request = await this.requestWithContext(
          messages,
          reminders,
          loop,
          loop.turns,
          finalTurn ? "finalize" : planMode ? "plan" : "turn",
          tools,
        );
        messages = request.messages;
        const response = request.response;
        messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
        this.syncConversation(messages);
        if (this.abortController?.signal.aborted) {
          // Partial assistant already synced; if there are tool calls, pair them with cancelled results.
          if (response.toolCalls.length) {
            for (const [index, call] of response.toolCalls.entries()) {
              ensureCallId(call, this.contextManager);
              await this.recordTool(
                task,
                messages,
                call,
                index,
                { ok: false, output: "", error: "tool cancelled", summary: "cancelled", metadata: { cancelled: true } },
                0,
                { executed: false },
              );
            }
          }
          this.throwIfCancelled();
        }
        if (!response.text && !response.toolCalls.length) throw new Error("model returned an empty response");
        if (finalTurn && response.toolCalls.length) {
          for (const [index, call] of response.toolCalls.entries()) {
            ensureCallId(call, this.contextManager);
            await this.recordTool(
              task,
              messages,
              call,
              index,
              {
                ok: false,
                output: "",
                error: "iteration limit reached; no more tools can be run",
                summary: "not run",
              },
              0,
              { executed: false },
            );
          }
          transitionTask(task, "failed");
          await this.persist(task);
          await this.emit("error", {
            message: `Reached the ${this.config.loop.maxSteps}-iteration limit before the model produced a final answer.`,
          });
          return task;
        }
        if (planMode && !response.toolCalls.length) {
          // Only hand off when the model explicitly marks the plan complete.
          // Ordinary conversation (e.g. "hi") must stay in plan mode and must
          // not auto-switch to execution.
          if (isPlanComplete(response.text)) {
            const planText = extractPlanText(response.text) || response.text.trim();
            const last = messages[messages.length - 1];
            if (last?.role === "assistant") {
              last.content = planText;
              this.syncConversation(messages);
            }
            task.plan = planText;
            task.result = planText;
            transitionTask(task, "completed");
            await this.persist(task);
            // Assistant stream already showed the plan body; mark streamed so the
            // reducer does not append a duplicate plan block.
            await this.emit("plan", { plan: planText, streamed: true, complete: true });
            await this.emit("plan_complete", { plan: planText, autoExecute: false });
            await this.emitCompleted(loop);
            return task;
          }
          this.throwIfCancelled();
          task.result = response.text;
          transitionTask(task, "completed");
          await this.persist(task);
          this.throwIfCancelled();
          await this.emitCompleted(loop);
          return task;
        }
        if (response.toolCalls.length) {
          const preExecutionNoProgress = loop.noProgressDiagnosticForNextCalls(response.toolCalls);
          if (preExecutionNoProgress) {
            this.recordNoProgressBlock(task, response.toolCalls, preExecutionNoProgress);
            await this.reconcileToolCalls(
              task,
              messages,
              response.toolCalls,
              "repeated identical tool call blocked before execution",
              false,
            );
            await this.pauseForNoProgress(task, preExecutionNoProgress);
            return task;
          }
          try {
            workspaceMutated ||= await this.runTools(task, messages, response.toolCalls, loop);
            const allReadonly = response.toolCalls.every((c) => inferToolKind(c.name) === "readonly");
            loop.recordTurnActivity({ hasMutation: workspaceMutated, isReadonly: allReadonly });
          } catch (error) {
            const cancelled = isAbortError(error) || this.abortController?.signal.aborted === true;
            await this.reconcileToolCalls(
              task,
              messages,
              response.toolCalls,
              cancelled ? "tool cancelled" : `tool execution stopped: ${formatErrorMessage(error)}`,
              cancelled,
            );
            throw error;
          }
          if (loop.shouldStopForUnknownTools()) {
            transitionTask(task, "failed");
            await this.persist(task);
            await this.emit("error", {
              message: `stopped after ${loop.consecutiveUnknownTools} consecutive unknown tool call(s)`,
            });
            return task;
          }
        } else if (loop.toolCalls.length === 0) {
          // A conversational response such as "hi" is complete as soon as the
          // model answers. Do not run workspace verification for turns that did
          // not perform any tool work.
          this.throwIfCancelled();
          task.result = response.text;
          transitionTask(task, "completed");
          await this.persist(task);
          this.throwIfCancelled();
          await this.emitCompleted(loop);
          return task;
        } else if (!workspaceMutated || this.config.workMode === "plan") {
          // Read-only exploration and ordinary conversation do not need a
          // verifier pass. In particular, saying "hi" or inspecting a project
          // must not unexpectedly run tests or builds.
          this.throwIfCancelled();
          task.result = response.text;
          transitionTask(task, "completed");
          await this.persist(task);
          this.throwIfCancelled();
          await this.emitCompleted(loop);
          return task;
        } else {
          const verification = await this.verify(task, messages);
          this.throwIfCancelled();
          if (verification.passed) {
            task.result = response.text;
            transitionTask(task, "completed");
            await this.persist(task);
            this.throwIfCancelled();
            await this.emitCompleted(loop);
            return task;
          }
          messages.push({ role: "user", content: `Verification failed:\n${verification.output}` });
          this.syncConversation(messages);
          transitionTask(task, "executing");
          await this.persist(task);
        }
        const noProgress = loop.noProgressDiagnostic();
        if (noProgress) {
          await this.pauseForNoProgress(task, noProgress);
          return task;
        }
      } finally {
        // Every started turn has one matching end event, including return, cancellation, and error paths.
        await this.fireHook({ event: "turn_end", workspace: task.workspace, model: this.config.model.model, userPrompt: task.prompt });
      }
    }
    if (loop.tokenBudgetReached()) {
      await this.pauseForTokenBudget(task, loop);
      return task;
    }
    transitionTask(task, "failed");
    await this.persist(task);
    await this.emit("error", {
      message: `Reached the ${this.config.loop.maxSteps}-iteration limit before the task completed.`,
    });
    return task;
  }

  private async requestWithContext(
    messages: Message[],
    reminders: readonly string[],
    loop: AgentLoop,
    step: number,
    source: string,
    tools: Record<string, unknown>[],
  ): Promise<{ messages: Message[]; response: ModelResponse }> {
    let managedMessages = repairToolMessagePairs(await this.prepareContext(messages, reminders, tools, loop));
    this.syncConversation(managedMessages);
    let requestMessages = withRuntimeReminders(managedMessages, reminders);
    await this.fireHook({ event: "before_model_request", workspace: this.config.workspace, model: this.config.model.model, userPrompt: this.hookUserPrompt });
    try {
      const response = await this.streamWithRetry(requestMessages, loop, step, source, tools);
      this.contextManager.recordUsage(response.usage, usageAnchorMessages(requestMessages, response), tools);
      await this.fireHook({ event: "after_model_response", workspace: this.config.workspace, model: this.config.model.model, assistantText: response.text });
      return { messages: managedMessages, response };
    } catch (error) {
      if (isAbortError(error) || this.abortController?.signal.aborted) throw error;
      if (!this.contextManager.isPromptTooLongError(error)) throw error;

      const contextWindow = this.contextManager.resolveContextWindow(this.config.model);
      const beforeTokens = this.contextManager.estimateTokens(requestMessages, tools);
      await this.emit("context_compaction", {
        phase: "started",
        reason: "emergency",
        beforeTokens,
        replacementCount: 0,
        message: "The provider rejected the request because the context window was exceeded. Compacting now.",
      });
      try {
        const compacted = await this.contextManager.compact({
          messages: requestMessages,
          provider: this.provider,
          tools,
          contextWindow,
          reason: "emergency",
          ...(this.abortController?.signal ? { signal: this.abortController.signal } : {}),
        });
        managedMessages = repairToolMessagePairs(compacted.messages);
        this.syncConversation(managedMessages);
        await this.emit("context_compaction", {
          phase: "completed",
          reason: "emergency",
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          replacementCount: compacted.replacementCount,
        });
      } catch (compactionError) {
        await this.emit("context_compaction", {
          phase: "failed",
          reason: "emergency",
          beforeTokens,
          replacementCount: 0,
          message: formatErrorMessage(compactionError),
        });
        throw compactionError;
      }

      this.throwIfCancelled();
      requestMessages = withRuntimeReminders(managedMessages, reminders);
      const response = await this.streamResponse(requestMessages, loop, step, source, 1, tools);
      this.contextManager.recordUsage(response.usage, usageAnchorMessages(requestMessages, response), tools);
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
    const beforeOffload = this.contextManager.estimateTokens(withRuntimeReminders(managedMessages, reminders), tools);
    const offload = await this.contextManager.offloadAndSnip(managedMessages);
    managedMessages = this.contextManager.refreshRecoveryMessage(offload.messages, tools);
    if (offload.replacementCount > 0 || offload.failedCount > 0) {
      const afterOffload = this.contextManager.estimateTokens(withRuntimeReminders(managedMessages, reminders), tools);
      await this.emit("context_compaction", {
        phase: "offloaded",
        reason: "auto",
        beforeTokens: beforeOffload,
        afterTokens: afterOffload,
        replacementCount: offload.replacementCount,
        ...(offload.failedCount > 0
          ? { message: `${offload.failedCount} tool result(s) could not be persisted and were kept in context.` }
          : {}),
      });
      this.syncConversation(managedMessages);
    }

    const requestMessages = withRuntimeReminders(managedMessages, reminders);
    const contextWindow = this.contextManager.resolveContextWindow(this.config.model);
    const beforeTokens = this.contextManager.estimateTokens(requestMessages, tools);
    const compactForContextWindow = this.contextManager.shouldAutoCompact(requestMessages, contextWindow, tools);

    const tokenBudget = loop.config.tokenBudget;
    const remainingBudget = Math.max(0, tokenBudget - loop.tokensUsed);
    const remainingRequests = Math.max(1, loop.remainingTurns() + 1);
    const sustainableRequestTokens = remainingBudget / remainingRequests;
    const budgetCompactionThreshold = Math.max(
      BUDGET_COMPACTION_MIN_REQUEST_TOKENS,
      sustainableRequestTokens * BUDGET_COMPACTION_HEADROOM,
      this.contextCompactionFloorTokens * BUDGET_COMPACTION_GROWTH_FACTOR,
    );
    const compactForTokenBudget = tokenBudget > 0
      && remainingBudget > 0
      && loop.turns - this.lastContextCompactionTurn >= BUDGET_COMPACTION_COOLDOWN_TURNS
      && beforeTokens >= budgetCompactionThreshold;
    if (!compactForContextWindow && !compactForTokenBudget) return managedMessages;

    const budgetMessage = compactForTokenBudget && !compactForContextWindow
      ? "Compacting early to keep the remaining model iterations within the task token budget."
      : undefined;
    this.lastContextCompactionTurn = loop.turns;
    await this.emit("context_compaction", {
      phase: "started",
      reason: "auto",
      beforeTokens,
      replacementCount: 0,
      ...(budgetMessage ? { message: budgetMessage } : {}),
    });
    try {
      const compacted = await this.contextManager.compact({
        messages: requestMessages,
        provider: this.provider,
        tools,
        contextWindow,
        reason: "auto",
        ...(this.abortController?.signal ? { signal: this.abortController.signal } : {}),
      });
      managedMessages = compacted.messages;
      this.contextCompactionFloorTokens = Math.max(1, compacted.afterTokens);
      this.syncConversation(managedMessages);
      await this.emit("context_compaction", {
        phase: "completed",
        reason: "auto",
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
        replacementCount: compacted.replacementCount,
        ...(budgetMessage ? { message: budgetMessage } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || this.abortController?.signal.aborted) throw error;
      const message = formatErrorMessage(error);
      await this.emit("context_compaction", {
        phase: "failed",
        reason: "auto",
        beforeTokens,
        replacementCount: 0,
        message,
      });
      this.logger(`Automatic context compaction failed: ${message}`);
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
    for (let attempt = 0; attempt <= this.config.loop.maxRetries; attempt += 1) {
      this.throwIfCancelled();
      try {
        return await this.streamResponse(messages, loop, step, source, attempt, tools);
      } catch (error) {
        if (isAbortError(error) || this.abortController?.signal.aborted) throw error;
        if (this.contextManager.isPromptTooLongError(error)) throw error;
        if (error instanceof ModelRequestError && !isRetryableModelStatus(error.status)) throw error;
        lastError = error;
        const message = formatErrorMessage(error);
        if (attempt >= this.config.loop.maxRetries) {
          // Final failure is reported by the outer execute() error event.
          throw error;
        }
        // Surface the concrete failure immediately, then announce the retry.
        await this.emit("retry", {
          step,
          source,
          attempt,
          nextAttempt: attempt + 1,
          maxRetries: this.config.loop.maxRetries,
          message,
        });
        this.appendDiagnosticStep("model_retry", {
          step,
          source,
          attempt,
          nextAttempt: attempt + 1,
          message,
        });
        this.debugLogger(JSON.stringify({
          event: "model_retry",
          taskId: this.activeTask?.id,
          step,
          source,
          attempt,
          nextAttempt: attempt + 1,
          message,
        }));
        this.logger(`Retrying ${source} response (${attempt + 1}/${this.config.loop.maxRetries}): ${message}`);
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
    await this.emit("assistant_start", { step, source, attempt, model: this.config.model.model }, turnId);
    const textParts: string[] = [];
    const completedToolCalls = new Map<number, ToolCall>();
    let toolCallChunkCount = 0;
    const usage: Record<string, number> = {};
    const reasoningParts: string[] = [];
    let streamed = false;
    let finishReason: string | undefined;
    let responseCompleted = false;
    try {
      const requestFingerprint = fingerprintRequest(messages);
      const estimatedRequestTokens = this.contextManager.estimateTokens(messages, tools);
      this.appendDiagnosticStep("model_request", {
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
      this.debugLogger(JSON.stringify({
        event: "model_request",
        taskId: this.activeTask?.id,
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
      }));
      const providerOptions = this.abortController?.signal
        ? { signal: this.abortController.signal }
        : undefined;
      const modelStartedAt = Date.now();
      for await (const chunk of this.provider.streamResponse(messages, tools, providerOptions)) {
        streamed ||= chunk.streamed;
        if (responseCompleted) {
          throw new Error(`provider emitted ${chunk.type} after response_complete`);
        }
        switch (chunk.type) {
          case "reasoning_delta":
            if (!thoughtStarted) {
              thoughtStarted = true;
              await this.emit("thought_start", { step, source, attempt }, turnId);
            }
            reasoningParts.push(chunk.text);
            await this.emit("thought_delta", { step, source, attempt, text: chunk.text }, turnId);
            break;
          case "text_delta":
            textParts.push(chunk.text);
            await this.emit("assistant_delta", { step, source, attempt, text: chunk.text }, turnId);
            break;
          case "tool_call_complete": {
            const call = parseCompletedToolCall(chunk.toolCall);
            const existing = completedToolCalls.get(chunk.toolCall.index);
            if (existing && !sameToolCall(existing, call)) {
              throw new Error(`provider emitted conflicting completed tool calls for index ${chunk.toolCall.index}`);
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
            if (responseCompleted) throw new Error("provider emitted response_complete more than once");
            responseCompleted = true;
            finishReason = chunk.finishReason;
            break;
        }
      }
      if (!responseCompleted) throw new Error("provider stream ended without a response_complete event");
      loop.recordModelElapsed(Math.max(1, Date.now() - modelStartedAt));
      loop.recordUsage(usage);
      const normalizedCalls = [...completedToolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => normalizeCallId(call, this.contextManager));
      const response: ModelResponse = {
        text: textParts.join(""),
        ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
        toolCalls: normalizedCalls,
        raw: { usage, finishReason, toolCalls: normalizedCalls },
        usage,
        streamed,
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
      this.modelResponseStepId = this.appendDiagnosticStep("model_response", {
        turnId,
        step,
        source,
        attempt,
        toolCallChunkCount,
        toolCalls: summarizeToolCalls(normalizedCalls),
        responseFingerprint: fingerprintResponse(response),
        finishReason,
        usage,
        taskTokensUsed: loop.tokensUsed,
      });
      this.debugLogger(JSON.stringify({
        event: "model_response",
        taskId: this.activeTask?.id,
        turnId,
        step,
        source,
        attempt,
        toolCallChunkCount,
        toolCalls: summarizeToolCalls(normalizedCalls),
        responseFingerprint: fingerprintResponse(response),
        finishReason,
        usage,
        taskTokensUsed: loop.tokensUsed,
      }));
      if (thoughtStarted) {
        await this.emit("thought_end", {
          step,
          source,
          attempt,
          text: response.reasoning ?? "",
          durationMs: Math.max(0, Date.now() - startedAt),
        }, turnId);
      }
      const displayText = this.config.workMode === "plan" ? extractPlanText(response.text) || response.text : response.text;
      await this.emit("assistant_end", { step, source, attempt, text: displayText, toolCalls: response.toolCalls, usage, streamed: response.streamed, ...(finishReason !== undefined ? { finishReason } : {}) }, turnId);
      return response;
    } catch (error) {
      if (thoughtStarted) {
        await this.emit("thought_end", {
          step,
          source,
          attempt,
          text: reasoningParts.join(""),
          durationMs: Math.max(0, Date.now() - startedAt),
        }, turnId);
      }
      const aborted = isAbortError(error) || this.abortController?.signal.aborted;
      // A non-cancellation model error is reported by the outer `error` event.
      // Emitting assistant_abort as well makes the TUI show the same failure
      // twice: once as a bracketed assistant suffix and once as an Error block.
      if (aborted) {
        await this.emit("assistant_abort", { step, source, attempt, message: formatErrorMessage(error), ...(finishReason !== undefined ? { finishReason } : {}) }, turnId);
      }
      if (aborted && (textParts.length || completedToolCalls.size || reasoningParts.length)) {
        // Preserve partial assistant output so conversation history stays usable after cancel.
        // Tool execution is only safe after the full provider response completed.
        loop.recordUsage(usage);
        return {
          text: textParts.join(""),
          ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
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

  private async runTools(task: Task, messages: Message[], calls: ToolCall[], loop: AgentLoop): Promise<boolean> {
    let workspaceMutated = false;
    const concurrency = Math.max(1, this.config.loop.readonlyConcurrency || 1);
    const deferredRecords: DeferredToolRecord[] = [];
    this.deferredToolRecords = deferredRecords;

    try {

    // Partition into ordered batches: consecutive readonly tools share a concurrent batch;
    // write/command/unknown tools run as singleton serial batches.
    type BatchItem = { index: number; call: ToolCall };
    const batches: BatchItem[][] = [];
    let readonlyBatch: BatchItem[] = [];
    const flushReadonly = (): void => {
      if (!readonlyBatch.length) return;
      batches.push(readonlyBatch);
      readonlyBatch = [];
    };

    for (const [index, call] of calls.entries()) {
      ensureCallId(call, this.contextManager);
      const known = this.registry.has(call.name);
      const kind = known ? (this.registry.get(call.name).kind ?? inferToolKind(call.name)) : "command";
      if (known && kind === "readonly") {
        readonlyBatch.push({ index, call });
      } else {
        flushReadonly();
        batches.push([{ index, call }]);
      }
    }
    flushReadonly();

    for (const batch of batches) {
      this.throwIfCancelled();
      if (batch.length === 1 && !this.registry.has(batch[0]!.call.name)) {
        const { index, call } = batch[0]!;
        await this.emit("tool_start", { call, index, permissionLevel: 4 });
        const hookBlock = await this.checkBeforeToolHook(task, call);
        if (hookBlock) {
          await this.recordTool(task, messages, call, index, hookBlock, 0, { executed: false });
          continue;
        }
        if (this.config.workMode === "plan") {
          await this.recordTool(task, messages, call, index, planModeDeniedResult(call), 0, { executed: false });
          continue;
        }
        const denied = await this.authorizeTool(task, call, 4, "command", "Unknown tool requested by the model.");
        if (denied) {
          await this.recordTool(task, messages, call, index, denied, 0, { executed: false });
          continue;
        }
        const result: ToolResult = {
          ok: false,
          output: "",
          error: `unknown tool: ${call.name}`,
          summary: "unknown tool",
        };
        loop.recordUnknownTool(call);
        await this.recordTool(task, messages, call, index, result, 0, { executed: false });
        this.logger(`Tool ${call.name}: unknown tool`);
        if (loop.shouldStopForUnknownTools()) return workspaceMutated;
        continue;
      }

      // Prepare approvals serially to keep policy/UI deterministic, then execute.
      type Prepared = {
        index: number;
        call: ToolCall;
        skip?: ToolResult;
      };
      const prepared: Prepared[] = [];
      for (const item of batch) {
        this.throwIfCancelled();
        const { index, call } = item;
        const tool = this.registry.get(call.name);
        const kind = tool.kind ?? inferToolKind(call.name);
        await this.emit("tool_start", { call, index, permissionLevel: tool.permissionLevel });
        const hookBlock = await this.checkBeforeToolHook(task, call);
        if (hookBlock) {
          prepared.push({ index, call, skip: hookBlock });
          continue;
        }
        if (!this.isToolVisible(tool)) {
          prepared.push({ index, call, skip: toolUnavailableResult(call) });
          continue;
        }
        if (this.config.workMode === "plan" && !isPlanModeTool(tool)) {
          prepared.push({ index, call, skip: planModeDeniedResult(call) });
          continue;
        }
        const denied = tool.system
          ? undefined
          : await this.authorizeTool(task, call, tool.permissionLevel, kind, tool.description);
        if (denied) {
          prepared.push({ index, call, skip: denied });
          continue;
        }
        const cacheKey = kind === "readonly" ? toolCallSignature(call) : undefined;
        if (cacheKey && this.readonlyCache.has(cacheKey)) {
          const cached = this.readonlyCache.get(cacheKey)!;
          this.debugLogger(JSON.stringify({
            event: "tool_cached_duplicate",
            taskId: task.id,
            turn: this.turnSequence,
            index,
            tool: call.name,
            arguments: summarizeArguments(call.arguments),
          }));
          loop.record(call);
          prepared.push({
            index,
            call,
            skip: {
              ...cached,
              metadata: { ...cached.metadata, cached: true },
            },
          });
          continue;
        }
        loop.record(call);
        prepared.push({ index, call });
      }

      const executable = prepared.filter((item) => !item.skip);
      if (this.snapshotStore && this.snapshotSessionId && executable.some((item) => this.isPotentiallyMutating(item.call))) {
        try {
          await this.snapshotStore.begin(this.snapshotSessionId, task);
        } catch (error) {
          this.debugLogger(JSON.stringify({ event: "snapshot_begin_failed", taskId: task.id, error: formatErrorMessage(error) }));
        }
      }
      const results = new Map<number, { call: ToolCall; result: ToolResult; duration: number; mutated: boolean }>();
      for (let offset = 0; offset < executable.length; offset += concurrency) {
        this.throwIfCancelled();
        const slice = executable.slice(offset, offset + concurrency);
        await Promise.all(slice.map(async (item) => {
          const started = Date.now();
          this.debugLogger(JSON.stringify({
            event: "tool_execute_start",
            taskId: task.id,
            turn: this.turnSequence,
            index: item.index,
            callId: item.call.id,
            tool: item.call.name,
            arguments: summarizeArguments(item.call.arguments),
          }));
          const beforeWorkspace = this.isPotentiallyMutating(item.call) ? await workspaceFingerprint(task.workspace) : undefined;
          const before = await fileHash(task.workspace, item.call);
          let result: ToolResult;
          try {
            const executionContext = this.abortController?.signal
              ? { workspace: task.workspace, signal: this.abortController.signal }
              : { workspace: task.workspace };
            result = await this.registry.invoke(item.call, executionContext);
          } catch (error) {
            if (isAbortError(error) || this.abortController?.signal.aborted) {
              result = { ok: false, output: "", error: "tool cancelled", summary: "cancelled", metadata: { cancelled: true } };
            } else {
              result = { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
            }
          }
          const duration = Date.now() - started;
          const after = await fileHash(task.workspace, item.call);
          const afterWorkspace = beforeWorkspace === undefined ? undefined : await workspaceFingerprint(task.workspace);
          const mutated = beforeWorkspace !== undefined && afterWorkspace !== undefined && beforeWorkspace !== afterWorkspace;
          if (before && after && before.hash !== after.hash) {
            this.trace.appendFileChange(task.id, before.path, before.hash, after.hash);
          }
          result = await this.offloadLargeToolResult(task, item.call, result);
          const executedResult = { ...result, durationMs: duration };
          if (result.ok && (this.registry.get(item.call.name)?.kind ?? inferToolKind(item.call.name)) === "readonly") {
            const cacheKey = toolCallSignature(item.call);
            this.readonlyCache.set(cacheKey, { ...executedResult, metadata: { ...executedResult.metadata, cached: false } });
          }
          results.set(item.index, { call: item.call, result: executedResult, duration, mutated });
        }));
      }

      // Write back in original model order (skipped + executed).
      for (const item of prepared) {
        if (item.skip) {
          await this.recordTool(task, messages, item.call, item.index, item.skip, 0, { executed: false });
          continue;
        }
        const entry = results.get(item.index);
        if (!entry) continue;
        if (entry.mutated) workspaceMutated = true;
        if (entry.result.ok && this.isPotentiallyMutating(entry.call)) this.readonlyCache.clear();
        if (entry.result.ok && entry.call.name === "read_file") {
          await this.trackSuccessfulFileRead(task.workspace, entry.call);
        }
        await this.recordTool(task, messages, entry.call, item.index, entry.result, entry.duration);
        this.logger(`Tool ${entry.call.name}: ${entry.result.summary ?? entry.result.ok}`);
      }
      this.throwIfCancelled();
    }
      return workspaceMutated;
    } finally {
      try {
        await this.flushDeferredToolRecords(task, messages, deferredRecords);
      } finally {
        if (this.deferredToolRecords === deferredRecords) this.deferredToolRecords = undefined;
      }
    }
  }

  private async reconcileToolCalls(
    task: Task,
    messages: Message[],
    calls: readonly ToolCall[],
    reason: string,
    cancelled: boolean,
  ): Promise<void> {
    const pairedIds = new Set(
      messages
        .filter((message) => message.role === "tool" && message.toolCallId)
        .map((message) => message.toolCallId!),
    );
    const blockedBeforeExecution = !cancelled && reason.includes("blocked before execution");
    for (const [index, call] of calls.entries()) {
      const id = ensureCallId(call, this.contextManager);
      if (pairedIds.has(id)) continue;
      await this.recordTool(task, messages, call, index, {
        ok: false,
        output: "",
        error: reason,
        summary: cancelled
          ? "cancelled"
          : blockedBeforeExecution
            ? "blocked before execution"
            : "not completed",
        metadata: {
          ...(cancelled ? { cancelled: true } : {}),
          ...(blockedBeforeExecution ? { blockedBeforeExecution: true } : {}),
          reconciled: true,
        },
      }, 0, { executed: false });
      pairedIds.add(id);
    }
  }

  private isPotentiallyMutating(call: ToolCall): boolean {
    const tool = this.registry.has(call.name) ? this.registry.get(call.name) : undefined;
    return tool
      ? (tool.kind ?? inferToolKind(call.name)) !== "readonly"
      : isMutatingToolName(call.name);
  }

  private async authorizeTool(
    task: Task,
    call: ToolCall,
    level: number,
    kind: ToolKind,
    description: string,
  ): Promise<ToolResult | undefined> {
    const decision = await this.permission.decide(call, level, kind);
    if (decision.verdict === "allow") return undefined;
    if (decision.verdict === "deny") return permissionDeniedResult(call, decision);

    const resumeState = task.state === "planning" ? "planning" : "executing";
    transitionTask(task, "awaiting_approval");
    await this.persist(task);
    let approval: ApprovalResponse;
    try {
      approval = await this.requestApproval(call, level, `${description}\nReason: ${decision.reason}`);
    } finally {
      if (task.state === "awaiting_approval" && !this.abortController?.signal.aborted) {
        transitionTask(task, resumeState);
        await this.persist(task);
      }
    }
    this.throwIfCancelled();

    if (approval === true) return undefined;
    if (approval === "task") {
      this.permission.allowForTask(call);
      return undefined;
    }
    if (approval === "always") {
      try {
        await this.permission.allowPermanently(call);
        return undefined;
      } catch (error) {
        return permissionDeniedResult(call, {
          ...decision,
          verdict: "deny",
          source: "user-decision",
          reason: `permanent allow could not be saved: ${formatErrorMessage(error)}`,
        });
      }
    }
    return permissionDeniedResult(call, {
      ...decision,
      verdict: "deny",
      source: "user-decision",
      reason: "the user rejected this tool call",
    });
  }

  private async recordTool(
    task: Task,
    messages: Message[],
    call: ToolCall,
    index: number,
    result: ToolResult,
    duration: number,
    options: { executed?: boolean } = {},
  ): Promise<void> {
    const deferredRecords = this.deferredToolRecords;
    if (deferredRecords) {
      deferredRecords.push({
        call,
        index,
        result,
        duration,
        executed: options.executed ?? true,
      });
      return;
    }
    await this.recordToolNow(task, messages, call, index, result, duration, options.executed ?? true);
  }

  private async flushDeferredToolRecords(
    task: Task,
    messages: Message[],
    records: readonly DeferredToolRecord[],
  ): Promise<void> {
    if (!records.length) return;
    const offload = await this.contextManager.offloadToolResults(records.map((record) => ({
      id: record.call.id ?? `call_${record.call.name}`,
      content: record.result.output || record.result.error || "",
    })));
    if (offload.offloadedCount > 0 || offload.failedCount > 0) {
      const payload: RuntimeEventPayloads["context_compaction"] = {
        phase: "offloaded",
        reason: "auto",
        replacementCount: offload.offloadedCount,
      };
      if (offload.failedCount > 0) payload.message = `${offload.failedCount} tool result(s) could not be offloaded.`;
      await this.emit("context_compaction", payload);
    }
    for (const record of records) {
      const replacement = offload.replacements.get(record.call.id ?? `call_${record.call.name}`);
      const result = replacement === undefined
        ? record.result
        : {
            ...record.result,
            output: replacement,
            ...(record.result.error ? { error: "tool failed; details offloaded" } : {}),
            metadata: {
              ...record.result.metadata,
              offloaded: true,
              originalBytes: record.result.metadata?.originalBytes
                ?? Buffer.byteLength(record.result.output || record.result.error || "", "utf8"),
            },
          };
      await this.recordToolNow(task, messages, record.call, record.index, result, record.duration, record.executed);
    }
  }

  private async offloadLargeToolResult(task: Task, call: ToolCall, result: ToolResult): Promise<ToolResult> {
    const content = result.output || result.error || "";
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes <= CONTEXT_LIMITS.singleToolResultBytes) return result;
    const id = call.id ?? `call_${call.name}`;
    const offload = await this.contextManager.offloadToolResults([{ id, content }]);
    const replacement = offload.replacements.get(id);
    if (replacement === undefined) return result;
    await this.emit("context_compaction", {
      phase: "offloaded",
      reason: "auto",
      replacementCount: 1,
      ...(offload.failedCount > 0 ? { message: "A large tool result could not be offloaded." } : {}),
    });
    this.debugLogger(JSON.stringify({
      event: "tool_result_offloaded_immediately",
      taskId: task.id,
      turn: this.turnSequence,
      callId: call.id,
      tool: call.name,
      originalBytes: bytes,
    }));
    return {
      ...result,
      output: replacement,
      ...(result.error ? { error: "tool failed; details offloaded" } : {}),
      metadata: { ...result.metadata, offloaded: true, originalBytes: bytes },
    };
  }

  private async recordToolNow(
    task: Task,
    messages: Message[],
    call: ToolCall,
    index: number,
    result: ToolResult,
    duration: number,
    executed: boolean,
  ): Promise<void> {
    const output = result.output || result.error || "";
    this.loop?.recordResult(call, result);
    if (call.name === "update_plan" && result.ok && result.output) {
      try {
        const parsed = JSON.parse(result.output) as { goal?: string; steps?: TaskPlanStep[]; currentStepIndex?: number };
        if (parsed && typeof parsed.goal === "string" && Array.isArray(parsed.steps)) {
          const planState: TaskPlanState = {
            goal: parsed.goal,
            steps: parsed.steps,
            currentStepIndex: parsed.currentStepIndex ?? 0,
            updatedAt: new Date().toISOString(),
          };
          task.planState = planState;
          await this.persist(task);
          await this.emit("task_plan_updated", { planState });
        }
      } catch (error) {
        this.debugLogger(JSON.stringify({ event: "update_plan_parse_failed", taskId: task.id, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    this.trace.appendToolCall(task.id, call.name, call.arguments, output, result.ok, duration, this.modelResponseStepId);
    await this.emit("tool_result", { call, index, result: { ...result, durationMs: duration } });
    if (executed) {
      await this.fireHook({ event: "after_tool_call", workspace: task.workspace, model: this.config.model.model, tool: call, filePath: extractToolFilePath(call) });
    }
    messages.push({ role: "tool", content: output || "(empty result)", toolCallId: call.id ?? `call_${call.name}`, name: call.name });
    this.syncConversation(messages);
    this.appendDiagnosticStep("tool_result", {
      step: this.turnSequence,
      index,
      callId: call.id,
      tool: call.name,
      arguments: summarizeArguments(call.arguments),
      ok: result.ok,
      outputBytes: Buffer.byteLength(output, "utf8"),
      resultAppended: true,
      executed,
      metadata: result.metadata,
    });
    this.debugLogger(JSON.stringify({
      event: "tool_result",
      taskId: task.id,
      turn: this.turnSequence,
      index,
      callId: call.id,
      tool: call.name,
      arguments: summarizeArguments(call.arguments),
      ok: result.ok,
      outputBytes: Buffer.byteLength(output, "utf8"),
      resultAppended: true,
      executed,
      metadata: result.metadata,
    }));
  }

  private recordNoProgressBlock(task: Task, calls: readonly ToolCall[], diagnostic: NoProgressDiagnostic): void {
    const { call, repeatCount, limit } = diagnostic;
    const payload = {
      turn: this.turnSequence,
      blockedCall: {
        id: call.id,
        name: call.name,
        arguments: summarizeArguments(call.arguments),
        repeatCount,
        limit,
      },
      batch: summarizeToolCalls(calls),
      reason: "repeated identical tool call blocked before execution",
    };
    this.appendDiagnosticStep("tool_call_blocked", payload);
    this.debugLogger(JSON.stringify({
      event: "tool_call_blocked",
      taskId: task.id,
      ...payload,
    }));
  }

  private async pauseForNoProgress(task: Task, diagnostic: NoProgressDiagnostic): Promise<void> {
    const { call, repeatCount, reason, detail } = diagnostic;
    transitionTask(task, "paused");
    await this.persist(task);
    let pauseMessage = "";
    if (reason === "repeated_error") {
      pauseMessage = `No progress detected; task paused after ${repeatCount} consecutive tool calls failed with identical error: "${detail ?? ""}".`;
    } else if (reason === "readonly_stall") {
      pauseMessage = `No progress detected; task paused after ${repeatCount} consecutive read-only exploration turns without workspace changes.`;
    } else {
      const argSummary = formatCallArguments(call.arguments);
      pauseMessage = `No progress detected; task paused before executing a repeated tool call. Repeated ${call.name}(${argSummary}) ${repeatCount} time(s).`;
    }
    await this.emit("log", {
      message: pauseMessage,
    });
  }

  private async pauseForTokenBudget(task: Task, loop: AgentLoop): Promise<void> {
    const budget = this.config.loop.tokenBudget;
    transitionTask(task, "paused");
    await this.persist(task);
    await this.emit("log", {
      message: `${tokenBudgetMessage(loop, budget)} Send "继续" to resume with a fresh budget.`,
    });
  }

  private appendDiagnosticStep(kind: string, payload: Record<string, unknown>): number | undefined {
    const taskId = this.activeTask?.id;
    if (!taskId) return undefined;
    return this.trace.appendStep(taskId, kind, payload);
  }

  private syncConversation(messages: readonly Message[]): void {
    this.conversation = cloneMessages(messages.filter((message) => (
      message.role !== "system" || message.metadata?.contextManaged === true
    )));
    this.conversationCallback(cloneMessages(this.conversation));
  }

  private async trackSuccessfulFileRead(workspace: string, call: ToolCall): Promise<void> {
    const rawPath = call.arguments.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) return;
    const root = resolve(workspace);
    const absolutePath = resolve(root, rawPath);
    const workspacePath = relative(root, absolutePath);
    if (workspacePath === ".." || workspacePath.startsWith(`..${sep}`) || resolve(root, workspacePath) !== absolutePath) return;
    try {
      const content = await readFile(absolutePath, "utf8");
      this.contextManager.trackSuccessfulFileRead(workspacePath.split(sep).join("/"), content);
    } catch (error) {
      this.logger(`Could not snapshot successful read_file result for context recovery: ${formatErrorMessage(error)}`);
    }
  }

  private async verify(task: Task, messages: Message[]): Promise<import("./types.js").VerificationResult> {
    transitionTask(task, "verifying");
    await this.persist(task);
    const commands = this.config.verifyCommands ?? Verifier.inferCommands(task.workspace);
    const results = this.config.skipVerify
      ? [{ command: "(skipped)", exitCode: 0, output: "Verification skipped by user.", durationMs: 0, passed: true }]
      : await this.verifier.runMany(commands, this.abortController?.signal);
    this.throwIfCancelled();
    const result = results.find((candidate) => !candidate.passed)
      ?? results.at(-1)
      ?? { command: "(none)", exitCode: 0, output: "No test/lint command configured; verification skipped.", durationMs: 0, passed: true };
    this.trace.appendStep(task.id, "verify", { results });
    await this.emit("verify", { results });
    return result;
  }

  private async requestApproval(call: ToolCall, level: number, description: string): Promise<ApprovalResponse> {
    const requestId = `approval-${++this.sequence}`;
    await this.emit("approval_request", { requestId, call, level, description });
    return this.approvalCallback(call, level, description, requestId);
  }

  private async persist(task: Task): Promise<void> {
    this.trace.saveTask(task);
    await this.emit("state", { state: task.state });
  }

  private async emitCompleted(loop: AgentLoop): Promise<void> {
    const elapsedMs = Math.max(0, Date.now() - this.taskStartedAt);
    const outputTokensPerSecond = loop.modelElapsedMs > 0 && loop.outputTokens > 0
      ? loop.outputTokens / (loop.modelElapsedMs / 1000)
      : undefined;
    await this.emit("completed", {
      steps: Math.max(1, loop.turns),
      tokensUsed: loop.tokensUsed,
      inputTokens: loop.inputTokens,
      outputTokens: loop.outputTokens,
      cacheReadTokens: loop.cacheReadTokens,
      cacheWriteTokens: loop.cacheWriteTokens,
      elapsedMs,
      modelElapsedMs: loop.modelElapsedMs,
      ...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }),
    });
  }

  private async emit<K extends keyof RuntimeEventPayloads>(type: K, payload: RuntimeEventPayloads[K], turnId?: string): Promise<void> {
    const base = { version: 1 as const, type, taskId: this.activeTask?.id ?? "unknown", sequence: ++this.sequence, timestamp: new Date().toISOString(), ...payload };
    const event = turnId === undefined ? base : { ...base, turnId };
    try { await this.eventCallback(event as RuntimeEvent); } catch (error) { this.logger(`event callback failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private toolSchemasForMode(): Record<string, unknown>[] {
    // Plan mode must always expose write_plan even though it is now deferred.
    // Activate it once before computing schemas so isExposed() lets it through.
    if (this.config.workMode === "plan") {
      const planTool = this.registry.list().find((tool) => tool.name === "write_plan");
      if (planTool && this.registry.isDeferred(planTool) && !this.registry.isExposed("write_plan")) {
        this.registry.activate("write_plan");
      }
    }
    return this.registry.schemas((tool) => (
      this.isToolVisible(tool)
      && (this.config.workMode !== "plan" || isPlanModeTool(tool))
    ));
  }

  private isToolVisible(tool: ToolDefinition): boolean {
    return tool.system === true || this.toolFilter(tool);
  }

  private async fireHook(ctx: HookEventPortContext): Promise<void> {
    if (!this.hookEngine) return;
    try {
      await this.hookEngine.dispatch(ctx);
    } catch (error) {
      // Hook 自身失败只记日志，绝不中断主流程
      this.logger(`hook ${ctx.event} dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 工具调用前派发，命中拦截即返回拒绝结果（带前缀「被 Hook 拒绝：<原因>」）。 */
  private async checkBeforeToolHook(task: Task, call: ToolCall): Promise<ToolResult | undefined> {
    if (!this.hookEngine) return undefined;
    try {
      const outcome = await this.hookEngine.dispatchBeforeTool({
        event: "before_tool_call",
        workspace: task.workspace,
        model: this.config.model.model,
        tool: call,
        filePath: extractToolFilePath(call),
        userPrompt: this.hookUserPrompt,
      });
      if (outcome.intercepted) {
        const reason = outcome.interceptReason ?? "blocked by hook";
        return {
          ok: false,
          output: `被 Hook 拒绝：${reason}`,
          error: reason,
          summary: `hook blocked: ${reason}`,
          metadata: { hookBlocked: true },
        };
      }
    } catch (error) {
      this.logger(`hook before_tool_call dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  private throwIfCancelled(): void {
    if (this.abortController?.signal.aborted) throw new DOMException("operation aborted", "AbortError");
  }
}

function permissionDeniedResult(call: ToolCall, decision: ApprovalDecision): ToolResult {
  return {
    ok: false,
    output: structuredPermissionDenial(call, decision),
    error: decision.reason,
    summary: `permission denied: ${decision.reason}`,
    metadata: { permissionDenied: true, permissionSource: decision.source },
  };
}

function planModeDeniedResult(call: ToolCall): ToolResult {
  return permissionDeniedResult(call, {
    verdict: "deny",
    reason: "plan mode only allows readonly tools and write_plan",
    source: "permission-mode",
    level: 4,
  });
}

function toolUnavailableResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    output: "",
    error: `tool unavailable in the current runtime: ${call.name}`,
    summary: "tool unavailable",
    metadata: { toolUnavailable: true },
  };
}

function isRetryableModelStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function ensureCallId(call: ToolCall, contextManager: ContextManager): string {
  if (call.id) return call.id;
  const id = contextManager.claimToolCallId();
  call.id = id;
  return id;
}

/** 从工具参数中提取文件路径，供 Hook 条件匹配与环境变量注入。 */
function extractToolFilePath(call: ToolCall): string {
  for (const key of ["path", "file_path", "target_path"]) {
    const value = call.arguments[key];
    if (typeof value === "string" && value.trim()) return value.trim().replaceAll("\\\\", "/");
  }
  return "";
}

function normalizeCallId(call: ToolCall, contextManager: ContextManager): ToolCall {
  return { ...call, id: contextManager.claimToolCallId(call.id) };
}

function parseCompletedToolCall(raw: ToolCallComplete): ToolCall {
  if (!Number.isInteger(raw.index) || raw.index < 0) {
    throw new Error(`invalid completed tool-call index: ${String(raw.index)}`);
  }
  if (!raw.name.trim()) throw new Error(`completed tool call ${raw.index} is missing a name`);
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(raw.argumentsJson);
  } catch (error) {
    throw new Error(`invalid arguments for completed tool call ${raw.index}: ${formatErrorMessage(error)}`);
  }
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error(`invalid arguments for completed tool call ${raw.index}: expected an object`);
  }
  return {
    ...(raw.id ? { id: raw.id } : {}),
    name: raw.name,
    arguments: argumentsValue as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
}

function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  return left.id === right.id
    && left.name === right.name
    && JSON.stringify(left.arguments) === JSON.stringify(right.arguments);
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({
      ...call,
      arguments: structuredClone(call.arguments),
    })) } : {}),
    ...(message.metadata ? { metadata: structuredClone(message.metadata) } : {}),
  }));
}

function tokenBudgetMessage(loop: AgentLoop, budget: number): string {
  return [
    `Token budget reached after ${loop.turns} model iteration(s): ${loop.tokensUsed.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")} task tokens.`,
    "Oran code preserved the completed response and stopped before another model request.",
    "Start a new session or use /compact (preferred) or /clear to reduce prior context, lower the reasoning effort, or increase agent.tokenBudget.",
  ].join(" ");
}

function withRuntimeReminders(messages: readonly Message[], reminders: readonly string[]): Message[] {
  const copy = cloneMessages(messages);
  // 运行时提醒追加到请求末尾（而非插在对话之前）：每轮变化的提醒文本不再击穿
  // 稳定前缀 [system + 对话] 的字节一致性，DeepSeek/OpenAI 前缀缓存可覆盖整段对话。
  if (reminders.length) copy.push(systemReminderMessage(reminders));
  return copy;
}

function usageAnchorMessages(messages: readonly Message[], response: ModelResponse): Message[] {
  return [
    ...messages,
    { role: "assistant", content: response.text, toolCalls: response.toolCalls },
  ];
}

function summarizeArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(argumentsValue).map(([key, value]) => [key, summarizeValue(value)]),
  );
}

function formatCallArguments(argumentsValue: Record<string, unknown>): string {
  return Object.entries(argumentsValue)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

function summarizeToolCalls(calls: readonly ToolCall[]): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: summarizeArguments(call.arguments),
  }));
}

function summarizeMessageTail(messages: readonly Message[]): Array<Record<string, unknown>> {
  return messages.slice(-6).map((message) => ({
    role: message.role,
    name: message.name,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls?.length ?? 0,
    contentBytes: Buffer.byteLength(message.content ?? "", "utf8"),
  }));
}

function fingerprintRequest(messages: readonly Message[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages.map((message) => ({
      role: message.role,
      name: message.name,
      toolCallId: message.toolCallId,
      content: message.content ?? "",
      toolCalls: message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    }))))
    .digest("hex")
    .slice(0, 16);
}

function fingerprintResponse(response: ModelResponse): string {
  return createHash("sha256")
    .update(JSON.stringify({
      text: response.text,
      reasoning: response.reasoning ?? "",
      toolCalls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
      finishReason: response.finishReason,
    }))
    .digest("hex")
    .slice(0, 16);
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, item]) => [key, summarizeValue(item)]),
    );
  }
  return value;
}

async function fileHash(workspace: string, call: ToolCall): Promise<{ path: string; hash: string | null } | undefined> {
  if (!isWriteToolName(call.name)) return undefined;
  const path = resolve(workspace, String(call.arguments.path ?? ""));
  const root = resolve(workspace);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  try {
    const data = await readFile(path);
    return { path, hash: createHash("sha256").update(data).digest("hex") };
  } catch {
    return { path, hash: null };
  }
}

const FINGERPRINT_IGNORED = new Set([".git", ".oran", ".litecode", ".venv", "venv", "node_modules", "dist", "build", "__pycache__"]);
const WORKSPACE_FINGERPRINT_TIMEOUT_MS = 750;
const WORKSPACE_FINGERPRINT_MAX_ENTRIES = 10_000;

function isPotentiallyMutating(call: ToolCall): boolean {
  return isMutatingToolName(call.name);
}

function inferToolKind(name: string): "readonly" | "write" | "command" {
  if (isWriteToolName(name)) return "write";
  if (["list_files", "read_file", "glob_files", "search_code", "git_status", "get_diff"].includes(name)) return "readonly";
  return "command";
}

async function workspaceFingerprint(root: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: WORKSPACE_FINGERPRINT_TIMEOUT_MS, windowsHide: true },
    );
    return `git:${result.stdout.split(/\r?\n/).filter(Boolean).sort().join("\n")}`;
  } catch {
    return collectWorkspaceEntries(resolve(root));
  }
}

async function collectWorkspaceEntries(root: string): Promise<string> {
  const entries: string[] = [];
  await collectWorkspaceEntriesRecursive(root, root, entries, Date.now() + WORKSPACE_FINGERPRINT_TIMEOUT_MS);
  return `scan:${entries.sort().join("\n")}`;
}

async function collectWorkspaceEntriesRecursive(
  root: string,
  directory: string,
  entries: string[],
  deadline: number,
): Promise<void> {
  if (entries.length >= WORKSPACE_FINGERPRINT_MAX_ENTRIES || Date.now() > deadline) return;
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (entries.length >= WORKSPACE_FINGERPRINT_MAX_ENTRIES || Date.now() > deadline) return;
    if (FINGERPRINT_IGNORED.has(child.name)) continue;
    const path = resolve(directory, child.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (child.isDirectory()) {
      entries.push(`d:${relativePath}`);
      await collectWorkspaceEntriesRecursive(root, path, entries, deadline);
      continue;
    }
    if (!child.isFile()) continue;
    try {
      const metadata = await stat(path);
      entries.push(`f:${relativePath}:${metadata.size}:${metadata.mtimeMs}`);
    } catch {
      // Files disappearing during a command are represented by their absence.
    }
  }
}

function isPlanComplete(text: string): boolean {
  // Require an explicit protocol marker. Free-form phrases such as
  // "plan complete" in ordinary replies must not trigger auto-execution.
  const normalized = text.replace(/\r/g, "");
  for (const marker of PLAN_COMPLETE_MARKERS) {
    if (normalized.includes(marker)) return true;
  }
  return false;
}

function extractPlanText(text: string): string {
  let plan = text.replace(/\r/g, "");
  for (const marker of PLAN_COMPLETE_MARKERS) {
    plan = plan.split(marker).join("");
  }
  plan = plan
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !/^plan\s+complete$/i.test(trimmed);
    })
    .join("\n");
  return plan.trim();
}
