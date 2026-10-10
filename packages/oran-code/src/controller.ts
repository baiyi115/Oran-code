import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { AgentLoop, type NoProgressDiagnostic } from "./loop.js";
import { ContextManager } from "./context-manager.js";
import { PermissionPolicy } from "./security.js";
import { discoverWorkspace } from "./workspace.js";
import { isAbortError } from "./utils/abort-error.js";
import { cloneMessages } from "./message-utils.js";
import {
  assistantMessage,
  EmptyModelResponseError,
  ensureCallId,
  extractPlanText,
  extractToolFilePath,
  formatCallArguments,
  inferToolKind,
  isPlanComplete,
  summarizeArguments,
  summarizeToolCalls,
  tokenBudgetMessage,
} from "./controller-utils.js";
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
  ToolCall,
  ToolDefinition,
  ToolResult,
  OptionalSystemPromptModules,
  HookEnginePort,
  HookEventPortContext,
} from "./types.js";
import { transitionTask } from "./types.js";
import { ToolBatchExecutor, type ToolBatchExecutionSummary } from "./controller/tool-executor.js";
import { TurnRequester } from "./controller/turn-requester.js";
import { formatErrorMessage } from "./error-format.js";
import { isCasualConversationPrompt } from "./prompt-intent.js";
import { PRODUCT_VERSION } from "./paths.js";
import { isPlanModeTool, type ToolRegistry } from "./tools.js";
import type { SnapshotStorePort } from "./snapshot.js";
import { captureTurnSnapshot, goalFingerprint } from "./progress/capture.js";
import {
  DEFAULT_EXPLORE_BUDGET,
  DEFAULT_IMPLEMENT_BUDGET,
  INITIAL_PHASE_STATE,
  isExplorationTask,
  updatePhase,
} from "./progress/phase.js";
import { updateNovelty } from "./progress/novelty.js";
import { judgeConvergence, parseRehearsal, rehearsalRequestNotice } from "./progress/rehearsal.js";
import { signalToNotice, computeSignals, type ProgressSignal } from "./progress/signals.js";
import { readCachedGraph } from "./graph/store.js";
import { selectRunState, type ProgressStopKind, MAX_SNAPSHOTS, ProgressStateStore } from "./progress/store.js";

/** Stable identity of one signal firing, used to inject each warn notice once. */
function signalKey(signal: ProgressSignal): string {
  return `${signal.kind}:${signal.sinceTurn}`;
}
import {
  buildEnvironmentPrompt,
  assembleStableSystemPrompt,
  environmentSystemMessage,
  loopBudgetReminder,
  stableSystemMessage,
  taskPlanReminder,
  taskModeReminder,
} from "./system-prompt.js";

export type RuntimeEventCallback = (event: RuntimeEvent) => void | Promise<void>;
export type RuntimeLogger = (message: string) => void;
export type ConversationCallback = (messages: readonly Message[]) => void;

/** Number of "continue after output was truncated" allowances within one task; past this limit the
 *  text received so far is used to wrap up. */
const MAX_TRUNCATION_RECOVERIES = 2;

/**
 * Pure-text truncation: the truncated message has no tool calls at all (nothing delivered, nothing
 * dropped).
 * Only text from this kind of truncation belongs to the answer and can take part in continuation
 * assembly; when a truncated message carries tool calls, the text is mostly a preamble of "what I
 * am about to do", and mixing it into the final answer would misrepresent it.
 */
function isTextOnlyTruncation(response: ModelResponse): boolean {
  return response.toolCalls.length === 0 && (response.truncatedToolCalls ?? 0) === 0;
}

/** Note appended to the end of the result when wrapping up with the text received so far: the task
 *  ends as completed, but the content is incomplete. */
function truncationNote(times: number): string {
  return `\n\n[output truncated by the output token limit ${times} time(s); the text above is incomplete]`;
}

export interface TaskControllerOptions {
  config: RuntimeConfig;
  provider: ModelProvider;
  registry: ToolRegistry;
  trace: TraceStore;
  verifier?: unknown;
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
  /** Hook engine port. No Hook events are enabled when it is absent. */
  hookEngine?: HookEnginePort;
  /** Text of the most recent user prompt, for Hook conditions/commands. */
  hookUserPrompt?: string;
  /** Tool call history already executed in the previous task, for the duplicate-call guard that
   *  carries across tasks. */
  previousToolCalls?: ToolCall[];
  /** Cache of successful readonly-tool results from the previous task; a repeated model call is
   *  filled in directly instead of being re-executed. */
  previousReadonlyResults?: ReadonlyMap<string, ToolResult>;
  /** Optional per-session file checkpoint store used by /undo. */
  snapshotStore?: SnapshotStorePort;
  snapshotSessionId?: string;
  /** Callback to poll steering messages queued by the user while the agent is running. */
  getSteeringMessages?: () => Promise<string[]> | string[];
  /**
   * Goal identity to adopt instead of hashing the prompt. /resume passes the
   * paused run's fingerprint so the task continues that run's state instead of
   * starting over (see resumedRunState).
   */
  resumedGoalFingerprint?: string;
  /** Handler for ask_user_question tool */
  askUserCallback?: (
    questions: Array<{
      header: string;
      question: string;
      options: Array<{ label: string; description: string; preview?: string | undefined }>;
      multiSelect?: boolean | undefined;
    }>,
  ) => Promise<Record<string, string>>;
}

export class TaskController {
  private readonly config: RuntimeConfig;
  private readonly provider: ModelProvider;
  private readonly registry: ToolRegistry;
  private readonly trace: TraceStore;
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
  private readonly getSteeringMessages: (() => Promise<string[]> | string[]) | undefined;
  private readonly resumedGoalFingerprint: string | undefined;
  /** Level-type warnings already injected; a rising edge is judged by "the condition still held in
   *  the previous turn". */
  private activeLevelSignals = new Set<string>();
  private readonly pendingSteeringMessages: string[] = [];
  /** Correction reminder for truncated model output, injected once before the next request. */
  private pendingTruncationNotice: string | undefined;
  /** Truncation recovery count for this task: past the limit the text received so far wraps up the
   *  task, avoiding unbounded retries. */
  private truncationRecoveries = 0;
  /** Pure-text truncation chunks (in arrival order), used to assemble the most complete result when
   *  wrapping up. */
  private truncatedTextChunks: string[] = [];
  private loop: AgentLoop | undefined;
  private abortController: AbortController | undefined;
  private activeTask: Task | undefined;
  private sequence = 0;
  private taskStartedAt = 0;
  private conversation: Message[];
  private readonly toolExecutor: ToolBatchExecutor;
  private readonly turnRequester: TurnRequester;
  /** Out-of-band progress store, reused per workspace; lives in .oran/progress/. */
  private readonly progressStores = new Map<string, ProgressStateStore>();
  /** Progress reminders queued this turn; drained into next turn's reminders. */
  private readonly pendingProgressNotices: string[] = [];
  /** Warn signals already injected, keyed by kind:turn, so they fire once. */
  private readonly notifiedProgressSignals = new Set<string>();
  /** Goal fingerprint whose recovery notices were already replayed in this process. */
  private progressRecoveryFor: string | undefined;

  constructor(options: TaskControllerOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.registry = options.registry;
    this.trace = options.trace;
    this.permission = options.permission ?? new PermissionPolicy(options.config.permissions);
    this.permission.registerTools(options.registry.list());
    this.approvalCallback = options.approvalCallback ?? (async () => false);
    this.eventCallback = options.eventCallback ?? (() => undefined);
    this.conversationCallback = options.conversationCallback ?? (() => undefined);
    // Wire the logger into the event channel by default: notifications such as truncation reminders,
    // offload failures and hook failures -- the "model cannot see but the user should" kind -- become
    // real log events (visible in both the TUI and headless).
    this.logger =
      options.logger ??
      ((message) => {
        void this.emit("log", { message }).catch(() => undefined);
      });
    this.debugLogger = options.debugLogger ?? (() => undefined);
    this.conversation = cloneMessages(options.conversation ?? []);
    this.contextManager =
      options.contextManager ??
      new ContextManager({
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
    this.getSteeringMessages = options.getSteeringMessages;
    this.resumedGoalFingerprint = options.resumedGoalFingerprint;
    if (options.previousReadonlyResults) {
      for (const [key, value] of options.previousReadonlyResults) this.readonlyCache.set(key, value);
    }
    this.turnRequester = new TurnRequester({
      config: this.config,
      provider: this.provider,
      contextManager: this.contextManager,
      logger: (message: string) => this.logger(message),
      debugLogger: (message: string) => this.debugLogger(message),
      emit: (type, payload, turnId) => this.emit(type, payload, turnId),
      fireHook: (ctx) => this.fireHook(ctx),
      syncConversation: (messages) => this.syncConversation(messages),
      appendDiagnosticStep: (kind, payload) => this.appendDiagnosticStep(kind, payload),
      throwIfCancelled: () => this.throwIfCancelled(),
      getAbortSignal: () => this.abortController?.signal,
      getActiveTaskId: () => this.activeTask?.id,
      getHookUserPrompt: () => this.hookUserPrompt,
    });
    this.toolExecutor = new ToolBatchExecutor({
      config: this.config,
      registry: this.registry,
      contextManager: this.contextManager,
      trace: this.trace,
      permission: this.permission,
      logger: (message: string) => this.logger(message),
      debugLogger: (message: string) => this.debugLogger(message),
      readonlyCache: this.readonlyCache,
      snapshotStore: this.snapshotStore,
      snapshotSessionId: this.snapshotSessionId,
      emit: (type, payload) => this.emit(type, payload),
      persist: (task) => this.persist(task),
      requestApproval: (call, level, description) => this.requestApproval(call, level, description),
      fireHook: (ctx) => this.fireHook(ctx),
      checkBeforeToolHook: (task, call) => this.checkBeforeToolHook(task, call),
      isToolVisible: (tool) => this.isToolVisible(tool),
      syncConversation: (messages) => this.syncConversation(messages),
      appendDiagnosticStep: (kind, payload) => this.appendDiagnosticStep(kind, payload),
      trackSuccessfulFileRead: (workspace, call) => this.trackSuccessfulFileRead(workspace, call),
      throwIfCancelled: () => this.throwIfCancelled(),
      getLoop: () => this.loop,
      getAbortSignal: () => this.abortController?.signal,
      getTurnSequence: () => this.turnRequester.currentTurnSequence,
      getModelResponseStepId: () => this.turnRequester.currentModelResponseStepId,
      askUser: options.askUserCallback,
    });
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

  pushSteeringMessage(text: string): void {
    if (text && text.trim()) {
      this.pendingSteeringMessages.push(text.trim());
    }
  }

  hasActiveLoop(): boolean {
    return Boolean(this.activeTask && this.loop && this.loop.canContinue());
  }

  async execute(task: Task): Promise<Task> {
    if (this.activeTask) throw new Error("task controller is already executing");
    this.activeTask = task;
    this.abortController = new AbortController();
    this.sequence = 0;
    this.taskStartedAt = Date.now();
    this.truncationRecoveries = 0;
    this.pendingTruncationNotice = undefined;
    this.truncatedTextChunks = [];
    this.turnRequester.resetForTask();
    const loop = new AgentLoop(this.config.loop, this.previousToolCalls);
    this.loop = loop;
    this.hookUserPrompt = task.prompt;
    await this.fireHook({
      event: "session_start",
      workspace: task.workspace,
      model: this.config.model.model,
      userPrompt: task.prompt,
    });
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
      // Session end: make sure it also fires on exceptional paths
      await this.fireHook({ event: "session_end", workspace: task.workspace, model: this.config.model.model });
      try {
        await this.snapshotStore?.finalize(task);
      } catch (error) {
        this.debugLogger(
          JSON.stringify({ event: "snapshot_finalize_failed", taskId: task.id, error: formatErrorMessage(error) }),
        );
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
    const userContent =
      this.conversation.length > 0
        ? `[Previous task completed. New user task begins below.]\nUser message:\n${task.prompt}`
        : `User message:\n${task.prompt}`;
    const turnConversation: Message[] = [
      ...cloneMessages(this.conversation),
      // taskId aligns the conversation turn with the file snapshot manifest, so /rewind --files can
      // roll back precisely to before this turn.
      { role: "user", content: userContent, metadata: { taskId: task.id } },
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
      environmentSystemMessage(
        buildEnvironmentPrompt({
          workspace: task.workspace,
          model: this.config.model,
          snapshot,
          appVersion: PRODUCT_VERSION,
        }),
      ),
      ...turnConversation,
    ];
    this.syncConversation(messages);

    while (loop.canContinue()) {
      this.throwIfCancelled();
      loop.recordTurn();

      // Ingest steering messages sent by user while tools were executing or waiting
      const externalSteering = this.getSteeringMessages ? await this.getSteeringMessages() : [];
      const pendingSteering = this.pendingSteeringMessages.splice(0);
      const allSteering = [...externalSteering, ...pendingSteering];
      if (allSteering.length > 0) {
        for (const steeringText of allSteering) {
          messages.push({
            role: "user",
            content: `[User steering guidance provided while task in progress]:\n${steeringText}`,
          });
        }
        this.syncConversation(messages);
      }

      const finalTurn = loop.isFinalTurn();
      const hookNotices = this.hookEngine ? this.hookEngine.drainNotices() : [];
      const noProgressWarning = loop.noProgressWarning();
      const reminders: string[] = [
        taskModeReminder(planMode, loop.turns),
        loopBudgetReminder(loop.remainingTurns(), finalTurn),
        ...this.runtimeReminders(),
        ...this.pendingProgressNotices.splice(0),
        ...hookNotices.map((notice) => `[hook:${notice.event}] ${notice.text}`),
      ].filter((item): item is string => Boolean(item && item.trim()));
      if (this.pendingTruncationNotice) {
        reminders.push(this.pendingTruncationNotice);
        this.pendingTruncationNotice = undefined;
      }
      if (casualConversation) {
        reminders.push(
          "The user sent a greeting or casual conversational message. Respond politely and concisely in direct text without calling any tools.",
        );
      }
      if (task.planState && task.planState.steps.length > 0) {
        reminders.push(taskPlanReminder(task.planState));
      }
      const contextUsageNotice = this.contextManager.contextUsageReminder(this.config.model, messages);
      if (contextUsageNotice) reminders.push(contextUsageNotice);
      if (noProgressWarning) {
        const { call, repeatCount, limit, reason, stage, detail } = noProgressWarning;
        if (reason === "repeated_error") {
          reminders.push(
            `Heads up: the last ${repeatCount} tool call(s) failed with the same error signature: "${detail ?? ""}". ` +
              `Please analyze the root cause before attempting the same approach again.`,
          );
        } else if (reason === "stalled_signature") {
          reminders.push(
            stage === "reflection"
              ? `Progress check required: ${detail ?? "recent turns have not produced new evidence"}. ` +
                  `State the current blocker internally, choose a materially different next action, and avoid repeating prior calls unless new external information is expected.`
              : `Heads up: ${detail ?? "recent turns have not produced new evidence"}. ` +
                  `Continue only when the next action can produce new information or advance the task.`,
          );
        } else {
          const argSummary = formatCallArguments(call.arguments);
          reminders.push(
            `Heads up: the previous ${repeatCount} call(s) to ${call.name}(${argSummary}) look identical. ` +
              `If this is not intentional, approach the task differently. Repeating ${limit} times will pause the task.`,
          );
        }
      }
      // Turn start: dispatched after the notification queue has been merged into this turn's reminders
      await this.fireHook({
        event: "turn_start",
        workspace: task.workspace,
        model: this.config.model.model,
        userPrompt: task.prompt,
      });
      try {
        const tools = finalTurn || casualConversation ? [] : this.toolSchemasForMode();
        const request = await this.turnRequester.requestWithContext(
          messages,
          reminders,
          loop,
          loop.turns,
          finalTurn ? "finalize" : planMode ? "plan" : "turn",
          tools,
        );
        messages = request.messages;
        const response = request.response;
        messages.push(assistantMessage(response));
        this.syncConversation(messages);
        // A pending structured rehearsal is judged on this reply before any
        // tool of the turn executes; divergence twice in a row pauses.
        const rehearsalPause = await this.consumeRehearsal(task, response.text);
        if (rehearsalPause) {
          await this.pauseForNoProgress(task, rehearsalPause);
          return task;
        }
        if (this.abortController?.signal.aborted) {
          // Partial assistant already synced; if there are tool calls, pair them with cancelled results.
          if (response.toolCalls.length) {
            for (const [index, call] of response.toolCalls.entries()) {
              ensureCallId(call, this.contextManager);
              await this.toolExecutor.recordTool(
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
        if (casualConversation) {
          const replyText = response.text.trim() || "你好！有什么我可以帮你的吗？";
          task.result = replyText;
          transitionTask(task, "completed");
          await this.persist(task);
          await this.emitCompleted(loop);
          return task;
        }
        if (!response.text && !response.toolCalls.length && !response.truncated) {
          throw new EmptyModelResponseError();
        }
        if (response.truncated) {
          // Output truncated by the limit: the content is incomplete, so it can neither be the final
          // answer nor have its tool calls executed (turn-requester already dropped every call in a
          // truncated message). A pure-text truncation is recorded first, giving the model one
          // explicit chance to correct course; when the budget runs out, the text received so far
          // wraps up the task, rather than throwing away what was generated along with the failure.
          this.truncationRecoveries += 1;
          const reason = response.finishReason ?? "length";
          if (isTextOnlyTruncation(response) && response.text.trim()) {
            this.truncatedTextChunks.push(response.text.trim());
          }
          const receivedChars = this.truncatedTextChunks.reduce((total, chunk) => total + chunk.length, 0);
          this.appendDiagnosticStep("model_truncated", {
            finishReason: reason,
            recovery: this.truncationRecoveries,
            limit: MAX_TRUNCATION_RECOVERIES,
            textOnly: isTextOnlyTruncation(response),
            receivedChars,
            droppedToolCalls: response.truncatedToolCalls ?? 0,
            finalTurn,
          });
          if (finalTurn || this.truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
            const assembled = this.assembleTruncatedText();
            if (assembled) {
              task.result = `${assembled}${truncationNote(this.truncationRecoveries)}`;
              this.logger(
                `Model output was truncated (finish_reason: ${reason}) ${this.truncationRecoveries} time(s); ` +
                  `completing the task with the ${assembled.length} characters received so far — the result is incomplete.`,
              );
              transitionTask(task, "completed");
              await this.persist(task);
              await this.emitCompleted(loop);
              return task;
            }
            transitionTask(task, "failed");
            await this.persist(task);
            await this.emit("error", {
              message:
                `Model output was truncated by the output token limit ${this.truncationRecoveries} times in a row ` +
                `(finish_reason: ${reason}) and no partial answer was received. Stopping instead of retrying forever; ` +
                `ask for smaller increments (one file or one function per step) or raise the model output limit.`,
            });
            return task;
          }
          this.pendingTruncationNotice =
            `Your previous response was cut off by the output token limit (finish_reason: ${reason}); ` +
            `nothing after the cut-off was received` +
            (receivedChars ? ` (about ${receivedChars} characters so far)` : "") +
            `. Continue from exactly where it stopped, in smaller pieces (e.g. one section or one file per turn), ` +
            `do not repeat content you already emitted, and re-issue any tool call you intended in full.`;
          this.logger(
            `Model output was truncated (finish_reason: ${reason}); asking the model to continue in smaller pieces ` +
              `(${this.truncationRecoveries}/${MAX_TRUNCATION_RECOVERIES}).`,
          );
          continue;
        }
        if (finalTurn && response.toolCalls.length) {
          for (const [index, call] of response.toolCalls.entries()) {
            ensureCallId(call, this.contextManager);
            await this.toolExecutor.recordTool(
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
              // Replace instead of mutating in place: the clone cache keys on object identity, so
              // mutating it would corrupt the cache.
              messages[messages.length - 1] = { ...last, content: planText };
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
          const nonReadonlyCalls = response.toolCalls.filter((call) => {
            if (!this.registry.has(call.name)) return true;
            const tool = this.registry.get(call.name);
            return (tool.kind ?? inferToolKind(call.name)) !== "readonly";
          });
          const preExecutionNoProgress = loop.noProgressDiagnosticForNextCalls(nonReadonlyCalls);
          if (preExecutionNoProgress) {
            // Only fake the blocked write/command calls; the readonly calls in the same batch were not
            // blocked, so they are left to the repair path to complete the pairing, avoiding a
            // "blocked" result in the transcript that does not match the facts.
            this.recordNoProgressBlock(task, nonReadonlyCalls, preExecutionNoProgress);
            await this.toolExecutor.reconcileToolCalls(
              task,
              messages,
              nonReadonlyCalls,
              "repeated tool execution blocked before execution",
              false,
            );
            await this.pauseForNoProgress(task, preExecutionNoProgress);
            return task;
          }
          try {
            const turnExecution = await this.toolExecutor.runTools(task, messages, response.toolCalls, loop);
            const progress = loop.recordTurnProgress({ hasMutation: turnExecution.workspaceMutated });
            this.appendDiagnosticStep("turn_progress", {
              turn: this.turnRequester.currentTurnSequence,
              readonlyOnly: turnExecution.readonlyOnly,
              ...progress,
            });
            const hardSignals = await this.recordProgressSnapshot(task, loop, { execution: turnExecution });
            if (hardSignals.length > 0) {
              const first = hardSignals[0]!;
              await this.pauseForNoProgress(task, {
                call: loop.toolCalls.at(-1) ?? {
                  name: "progress_signal",
                  arguments: {},
                  createdAt: new Date().toISOString(),
                },
                repeatCount: hardSignals.length,
                limit: hardSignals.length,
                reason: "progress_signal",
                stage: "pause",
                detail: `${first.kind}: ${first.detail}`,
              });
              return task;
            }
          } catch (error) {
            const cancelled = isAbortError(error) || this.abortController?.signal.aborted === true;
            await this.toolExecutor.reconcileToolCalls(
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
        } else {
          // The model finished calling tools and returned its final response.
          // Complete the task directly without running any verification harness.
          this.throwIfCancelled();
          // If a pure-text truncation happened earlier, this last chunk continues it: assemble the
          // full answer before wrapping up.
          task.result = this.assembleTruncatedText(response.text);
          transitionTask(task, "completed");
          await this.persist(task);
          await this.recordCompletionStop(task);
          this.throwIfCancelled();
          await this.emitCompleted(loop);
          return task;
        }
        const noProgress = loop.noProgressDiagnostic();
        if (noProgress) {
          await this.pauseForNoProgress(task, noProgress);
          return task;
        }
      } finally {
        // Every started turn has one matching end event, including return, cancellation, and error paths.
        await this.fireHook({
          event: "turn_end",
          workspace: task.workspace,
          model: this.config.model.model,
          userPrompt: task.prompt,
        });
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

  private recordNoProgressBlock(task: Task, calls: readonly ToolCall[], diagnostic: NoProgressDiagnostic): void {
    const { call, repeatCount, limit } = diagnostic;
    const payload = {
      turn: this.turnRequester.currentTurnSequence,
      blockedCall: {
        id: call.id,
        name: call.name,
        arguments: summarizeArguments(call.arguments),
        repeatCount,
        limit,
      },
      batch: summarizeToolCalls(calls),
      reason: "repeated tool execution blocked before execution",
    };
    this.appendDiagnosticStep("tool_call_blocked", payload);
    this.debugLogger(
      JSON.stringify({
        event: "tool_call_blocked",
        taskId: task.id,
        ...payload,
      }),
    );
  }

  private async pauseForNoProgress(task: Task, diagnostic: NoProgressDiagnostic): Promise<void> {
    const { call, repeatCount, reason, detail } = diagnostic;
    transitionTask(task, "paused");
    await this.persist(task);
    await this.recordProgressStop(task, "blocked");
    let pauseMessage: string;
    if (reason === "repeated_error") {
      pauseMessage = `No progress detected; task paused after ${repeatCount} consecutive tool calls failed with identical error: "${detail ?? ""}".`;
    } else if (reason === "progress_signal") {
      pauseMessage =
        `Progress gate: task paused — ${detail ?? "a hard progress signal fired"}. ` +
        `Run /resume to continue this task with the gate disarmed, or send a new instruction to start over.`;
    } else if (reason === "stalled_signature") {
      pauseMessage = `No progress detected; task paused after ${repeatCount} consecutive turns without new tool results or workspace changes.`;
    } else if (reason === "repeated_execution") {
      const argSummary = formatCallArguments(call.arguments);
      pauseMessage = `No progress detected; task paused before a third identical ${call.name}(${argSummary}) execution with the same prior result.`;
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
    await this.recordProgressStop(task, "stopped_by_budget");
    await this.emit("log", {
      message: `${tokenBudgetMessage(loop, budget)} Run /resume to continue this task with a fresh budget.`,
    });
  }

  private appendDiagnosticStep(kind: string, payload: Record<string, unknown>): number | undefined {
    const taskId = this.activeTask?.id;
    if (!taskId) return undefined;
    return this.trace.appendStep(taskId, kind, payload);
  }

  /** Messages are treated as immutable once enqueued; deep clones are cached by object identity, so
   *  a sync only pays for new messages. */
  private readonly conversationClones = new WeakMap<Message, Message>();

  private cachedClone(message: Message): Message {
    let cached = this.conversationClones.get(message);
    if (!cached) {
      cached = cloneMessages([message])[0]!;
      this.conversationClones.set(message, cached);
    }
    return cached;
  }

  private syncConversation(messages: readonly Message[]): void {
    const filtered = messages.filter(
      (message) => message.role !== "system" || message.metadata?.contextManaged === true,
    );
    this.conversation = filtered.map((message) => this.cachedClone(message));
    this.conversationCallback([...this.conversation]);
  }

  private async trackSuccessfulFileRead(workspace: string, call: ToolCall): Promise<void> {
    const rawPath = call.arguments.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) return;
    const root = resolve(workspace);
    const absolutePath = resolve(root, rawPath);
    const workspacePath = relative(root, absolutePath);
    if (workspacePath === ".." || workspacePath.startsWith(`..${sep}`) || resolve(root, workspacePath) !== absolutePath)
      return;
    try {
      const content = await readFile(absolutePath, "utf8");
      this.contextManager.trackSuccessfulFileRead(workspacePath.split(sep).join("/"), content);
    } catch (error) {
      this.logger(`Could not snapshot successful read_file result for context recovery: ${formatErrorMessage(error)}`);
    }
  }

  private async requestApproval(call: ToolCall, level: number, description: string): Promise<ApprovalResponse> {
    const requestId = `approval-${++this.sequence}`;
    await this.emit("approval_request", { requestId, call, level, description });
    return this.approvalCallback(call, level, description, requestId);
  }

  private async persist(task: Task): Promise<void> {
    this.trace.saveTask(task);
    // Terminal states (including pause) must not lose the last snapshot.
    await this.progressStoreFor(task.workspace)
      .flush()
      .catch(() => undefined);
    await this.emit("state", { state: task.state });
  }

  private progressStoreFor(workspace: string): ProgressStateStore {
    let store = this.progressStores.get(workspace);
    if (!store) {
      store = new ProgressStateStore(workspace);
      this.progressStores.set(workspace, store);
    }
    return store;
  }

  /**
   * Goal identity of this task: the resumed run's fingerprint when /resume
   * adopted one, otherwise a hash of the prompt.
   */
  private progressGoalFingerprint(task: Task): string {
    return this.resumedGoalFingerprint ?? goalFingerprint(task.prompt);
  }

  /**
   * Capture a snapshot after each turn's tool execution and persist it outside
   * the conversation. Returns the hard signals that fired this turn; the caller
   * turns them into a pause. Failures degrade to a missing snapshot only —
   * capture must never break the main flow.
   */
  private async recordProgressSnapshot(
    task: Task,
    loop: AgentLoop,
    context: { execution: ToolBatchExecutionSummary },
  ): Promise<readonly ProgressSignal[]> {
    try {
      const store = this.progressStoreFor(task.workspace);
      const persisted = await store.load();
      const fingerprint = this.progressGoalFingerprint(task);
      const budgets = {
        exploreBudget: persisted.exploreBudget > 0 ? persisted.exploreBudget : DEFAULT_EXPLORE_BUDGET,
        implementBudget: persisted.implementBudget > 0 ? persisted.implementBudget : DEFAULT_IMPLEMENT_BUDGET,
      };
      const resumed = this.resumedGoalFingerprint !== undefined;
      const { state, origin } = selectRunState(persisted, fingerprint, { resumed });
      if (origin === "interrupted" && this.progressRecoveryFor !== fingerprint) {
        // Interrupted run — the process died, or the user re-ran the same prompt
        // while it was still in flight. Replay the window's warn-and-above
        // signals once so the model re-learns what went wrong.
        this.progressRecoveryFor = fingerprint;
        for (const signal of computeSignals({
          snapshots: state.snapshots,
          phase: state.phase ?? INITIAL_PHASE_STATE,
          allowedPaths: state.allowedPaths,
          budgets,
        })) {
          this.notifiedProgressSignals.add(signalKey(signal));
          // Seeded as active so the replayed warning is not immediately
          // injected a second time by the rising-edge rule below.
          this.activeLevelSignals.add(signal.kind);
          if (signal.severity !== "info") this.pendingProgressNotices.push(signalToNotice(signal));
        }
      }
      const disarmed = state.enforcement === "off";

      const mutatedCallIds = new Set(context.execution.mutatedCallIds);
      // The loop keeps this turn's records separately: slicing executionHistory
      // by an index returns an empty list once its 50-entry cap starts dropping
      // the oldest entries, which silently disabled the whole progress layer on
      // exactly the long tasks it exists for.
      const executed = loop.turnExecutionRecords().map((item) => ({
        call: item.call,
        result: item.result,
        mutated: item.call.id !== undefined && mutatedCallIds.has(item.call.id),
      }));
      const snapshot = await captureTurnSnapshot({
        turn: loop.turns,
        workspace: task.workspace,
        executed,
        isReadonly: (name) => {
          const tool = this.registry.has(name) ? this.registry.get(name) : undefined;
          return (tool?.kind ?? inferToolKind(name)) === "readonly";
        },
        cumulativeTokensIn: loop.inputTokens,
        cumulativeTokensOut: loop.outputTokens,
        previousTrackedPaths: state.allowedPaths,
        previous: state.snapshots.at(-1),
      });
      const explorationTask = isExplorationTask(task.prompt);
      // Mechanism B (both halves) is off for exploration-declared tasks, whose
      // criteria do not apply, and for a task the user resumed, which is the
      // point of resuming. Mechanism B1 used to run regardless, so a declared
      // research task still got the "no new information" warning.
      const gateActive = !explorationTask && !disarmed;
      const phaseResult = updatePhase(state.phase, snapshot, budgets);
      // Mechanism B2: once the exploration budget is exhausted, require a
      // structured rehearsal instead of stopping.
      let rehearsal = state.rehearsal;
      if (
        gateActive &&
        phaseResult.state.phase === "explore" &&
        phaseResult.state.readonlyFilesRead > budgets.exploreBudget &&
        !rehearsal
      ) {
        this.pendingProgressNotices.push(rehearsalRequestNotice(true));
        rehearsal = { phase: "requested", requestedTurn: snapshot.turn };
      }

      // Mechanism B1: symbol novelty over this turn's successful reads.
      let novelty = state.novelty;
      if (gateActive && phaseResult.state.phase === "explore") {
        const reads = executed
          .filter((item) => item.call.name === "read_file" && item.result.ok)
          .map((item) => {
            const rawPath = item.call.arguments.path;
            const file = typeof rawPath === "string" ? rawPath.replaceAll("\\", "/").replace(/^\.\//, "") : "";
            return { file, text: item.result.output ?? "" };
          })
          .filter((read) => read.file !== "");
        if (reads.length > 0) {
          const graph = await readCachedGraph(task.workspace).catch(() => undefined);
          const graphSymbolsByFile = new Map<string, string[]>();
          for (const symbol of graph?.symbols ?? []) {
            const bucket = graphSymbolsByFile.get(symbol.file);
            if (bucket) bucket.push(symbol.name);
            else graphSymbolsByFile.set(symbol.file, [symbol.name]);
          }
          const noveltyReads = reads.map((read) => ({
            file: read.file,
            graphSymbols: graphSymbolsByFile.get(read.file.replace(/^\//, "")),
            text: read.text,
          }));
          const noveltyResult = updateNovelty(state.novelty, noveltyReads);
          novelty = noveltyResult.state;
          if (noveltyResult.signal) {
            const signal = { ...noveltyResult.signal, sinceTurn: snapshot.turn };
            this.debugLogger(JSON.stringify({ event: "progress_signal", ...signal }));
            const key = signalKey(signal);
            if (!this.notifiedProgressSignals.has(key)) {
              this.notifiedProgressSignals.add(key);
              this.pendingProgressNotices.push(signalToNotice(signal));
            }
          }
        }
      }

      // The task's file footprint comes from the snapshot, which grows it with
      // this turn's writes; the goal-drift anchor was previously frozen at the
      // first mutating turn, so a TDD run or a multi-file change counted its own
      // later files as out of scope.
      const allowedPaths = snapshot.trackedPaths;
      const snapshots = [...state.snapshots, snapshot].slice(-MAX_SNAPSHOTS);

      const levelSignals = computeSignals({ snapshots, phase: phaseResult.state, allowedPaths, budgets });
      const hardSignals: ProgressSignal[] = [];
      for (const signal of [...phaseResult.signals, ...levelSignals]) {
        this.debugLogger(JSON.stringify({ event: "progress_signal", ...signal }));
        if (signal.severity === "hard") {
          if (disarmed) {
            // The gate is disarmed by /resume: record the signal, do not stop.
            // Pausing here would overrule a decision the user just made.
            this.debugLogger(JSON.stringify({ event: "progress_signal_suppressed", ...signal }));
            continue;
          }
          hardSignals.push(signal);
          continue;
        }
        // info stays in the debug log; warn is injected into the next request.
        if (signal.severity !== "warn") continue;
        if (levelSignals.includes(signal)) {
          // Level signals are recomputed every turn while their condition holds.
          // Keying them by turn made each turn a new key, so the same notice was
          // re-injected for as long as the window remembered the condition;
          // notify on the rising edge instead.
          if (!this.activeLevelSignals.has(signal.kind)) this.pendingProgressNotices.push(signalToNotice(signal));
          continue;
        }
        const key = signalKey(signal);
        if (this.notifiedProgressSignals.has(key)) continue;
        this.notifiedProgressSignals.add(key);
        this.pendingProgressNotices.push(signalToNotice(signal));
      }
      this.activeLevelSignals = new Set(levelSignals.map((signal) => signal.kind));

      // Intermediate write debounces; persist() flushes on every state transition.
      store.scheduleSave({
        ...state,
        phase: phaseResult.state,
        novelty,
        rehearsal,
        allowedPaths,
        updatedAt: new Date().toISOString(),
        snapshots,
      });
      return hardSignals;
    } catch (error) {
      this.debugLogger(JSON.stringify({ event: "progress_capture_failed", error: formatErrorMessage(error) }));
      return [];
    }
  }

  /**
   * Judge a pending structured rehearsal against the model's latest reply.
   * Convergence resets the exploration counter; a second divergence returns
   * a synthesized pause diagnostic for the caller.
   */
  private async consumeRehearsal(task: Task, reply: string): Promise<NoProgressDiagnostic | undefined> {
    try {
      const store = this.progressStoreFor(task.workspace);
      const state = await store.load();
      const rehearsal = state.rehearsal;
      if (!rehearsal || state.goalFingerprint !== this.progressGoalFingerprint(task)) return undefined;

      const parsed = parseRehearsal(reply);
      if (parsed && judgeConvergence(rehearsal.last, parsed) === "converged") {
        const phase = state.phase ? { ...state.phase, readonlyFilesRead: 0 } : state.phase;
        await store.save({
          ...state,
          phase,
          rehearsal: undefined,
          updatedAt: new Date().toISOString(),
        });
        this.pendingProgressNotices.push(
          "Rehearsal accepted: the exploration state converged. Proceed with your stated next check.",
        );
        return undefined;
      }

      if (rehearsal.phase === "requested") {
        await store.save({
          ...state,
          rehearsal: { phase: "reflected", requestedTurn: rehearsal.requestedTurn, last: parsed },
          updatedAt: new Date().toISOString(),
        });
        this.pendingProgressNotices.push(rehearsalRequestNotice(false));
        return undefined;
      }

      // Already had its second chance and still did not converge.
      await store.save({ ...state, rehearsal: undefined, updatedAt: new Date().toISOString() });
      return {
        call: this.loop?.toolCalls.at(-1) ?? {
          name: "progress_signal",
          arguments: {},
          createdAt: new Date().toISOString(),
        },
        repeatCount: 1,
        limit: 1,
        reason: "progress_signal",
        stage: "pause",
        detail: parsed
          ? "rehearsal_diverged: the candidate set did not shrink and the exclusion list did not grow"
          : "rehearsal_diverged: the reply was not a parseable rehearsal JSON",
      };
    } catch {
      return undefined;
    }
  }

  /** Record how a task ended, for the next run of the same goal. */
  private async recordProgressStop(task: Task, kind: ProgressStopKind): Promise<void> {
    try {
      const store = this.progressStoreFor(task.workspace);
      const state = await store.load();
      const fingerprint = this.progressGoalFingerprint(task);
      if (state.goalFingerprint !== fingerprint) return;
      await store.save({
        ...state,
        stop: { kind, turn: this.loop?.turns ?? 0, ts: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Stop metadata is best-effort; never fail the transition for it.
    }
  }

  /**
   * Completed tasks end "verified" when the last snapshot carried positive
   * external evidence (tests/typecheck/build), "review_required" otherwise.
   */
  private async recordCompletionStop(task: Task): Promise<void> {
    try {
      const store = this.progressStoreFor(task.workspace);
      const state = await store.load();
      const evidence = state.snapshots.at(-1)?.evidence;
      const verified =
        (evidence?.testsPassed !== undefined && evidence.testsPassed > 0) ||
        evidence?.typecheckOk === true ||
        evidence?.buildOk === true;
      await this.recordProgressStop(task, verified ? "verified" : "review_required");
    } catch {
      await this.recordProgressStop(task, "review_required");
    }
  }

  /**
   * Assembles the truncated-continuation chunks and the last chunk into the result.
   * With no truncation continuations this is the last chunk itself; with them, the order is arrival
   * order and chunks are separated by a blank line.
   */
  private assembleTruncatedText(finalText = ""): string {
    const parts = [...this.truncatedTextChunks];
    const trimmed = finalText.trim();
    if (trimmed) parts.push(trimmed);
    return parts.join("\n\n");
  }

  private async emitCompleted(loop: AgentLoop): Promise<void> {
    const elapsedMs = Math.max(0, Date.now() - this.taskStartedAt);
    const outputTokensPerSecond =
      loop.modelElapsedMs > 0 && loop.outputTokens > 0 ? loop.outputTokens / (loop.modelElapsedMs / 1000) : undefined;
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

  private async emit<K extends keyof RuntimeEventPayloads>(
    type: K,
    payload: RuntimeEventPayloads[K],
    turnId?: string,
  ): Promise<void> {
    const base = {
      version: 1 as const,
      type,
      taskId: this.activeTask?.id ?? "unknown",
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    const event = turnId === undefined ? base : { ...base, turnId };
    try {
      await this.eventCallback(event as RuntimeEvent);
    } catch (error) {
      // A failed dispatch of a log event is not written back to the logger: the default logger turns
      // the message into another log event, and writing back would loop forever.
      if (type !== "log") {
        this.logger(`event callback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private toolSchemasForMode(): Record<string, unknown>[] {
    return this.registry.schemas(
      (tool) => this.isToolVisible(tool) && (this.config.workMode !== "plan" || isPlanModeTool(tool)),
    );
  }

  private isToolVisible(tool: ToolDefinition): boolean {
    return tool.system === true || this.toolFilter(tool);
  }

  private async fireHook(ctx: HookEventPortContext): Promise<void> {
    if (!this.hookEngine) return;
    try {
      await this.hookEngine.dispatch(ctx);
    } catch (error) {
      // A failing Hook is only logged; it never interrupts the main flow
      this.logger(`hook ${ctx.event} dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Dispatched before a tool call; on interception it returns a denial result whose output carries
   *  the hook's denial prefix followed by the reason (see the result built below). */
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
