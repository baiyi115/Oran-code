import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { AgentLoop, type NoProgressDiagnostic } from "./loop.js";
import { ContextManager } from "./context-manager.js";
import { PermissionPolicy } from "./security.js";
import { discoverWorkspace } from "./workspace.js";
import { Verifier } from "./verifier.js";
import { isAbortError } from "./utils/abort-error.js";
import { cloneMessages } from "./message-utils.js";
import {
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
import { ToolBatchExecutor } from "./controller/tool-executor.js";
import { TurnRequester } from "./controller/turn-requester.js";
import { formatErrorMessage } from "./error-format.js";
import { isCasualConversationPrompt } from "./prompt-intent.js";
import { PRODUCT_VERSION } from "./paths.js";
import { isPlanModeTool, type ToolRegistry } from "./tools.js";
import type { SnapshotStorePort } from "./snapshot.js";
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
  private taskStartedAt = 0;
  private conversation: Message[];
  private readonly toolExecutor: ToolBatchExecutor;
  private readonly turnRequester: TurnRequester;

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

  async execute(task: Task): Promise<Task> {
    if (this.activeTask) throw new Error("task controller is already executing");
    this.activeTask = task;
    this.abortController = new AbortController();
    this.sequence = 0;
    this.taskStartedAt = Date.now();
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
      // 会话结束：确保异常路径也能触发
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
        const { call, repeatCount, limit, reason, stage, detail } = noProgressWarning;
        if (reason === "repeated_error") {
          reminders.push(
            `Heads up: the last ${repeatCount} tool call(s) failed with the same error signature: "${detail ?? ""}". ` +
              `Please analyze the root cause before attempting the same approach again.`,
          );
        } else if (reason === "semantic_stall") {
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
      // 轮次开始：通知队列已并入本轮系统提醒后派发
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
        messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
        this.syncConversation(messages);
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
        if (!response.text && !response.toolCalls.length) throw new Error("model returned an empty response");
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
              // 以替换代替就地改写:克隆缓存按对象身份生效,改写会使其失真。
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
            this.recordNoProgressBlock(task, response.toolCalls, preExecutionNoProgress);
            await this.toolExecutor.reconcileToolCalls(
              task,
              messages,
              response.toolCalls,
              "repeated tool execution blocked before execution",
              false,
            );
            await this.pauseForNoProgress(task, preExecutionNoProgress);
            return task;
          }
          try {
            const turnExecution = await this.toolExecutor.runTools(task, messages, response.toolCalls, loop);
            workspaceMutated ||= turnExecution.workspaceMutated;
            const progress = loop.recordTurnProgress({ hasMutation: turnExecution.workspaceMutated });
            this.appendDiagnosticStep("turn_progress", {
              turn: this.turnRequester.currentTurnSequence,
              readonlyOnly: turnExecution.readonlyOnly,
              ...progress,
            });
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
          const verification = await this.verify(task);
          this.throwIfCancelled();
          if (verification.passed) {
            task.result = response.text;
            transitionTask(task, "completed");
            await this.persist(task);
            this.throwIfCancelled();
            await this.emitCompleted(loop);
            return task;
          }
          const progress = loop.recordTurnProgress({
            hasMutation: false,
            externalEvidence: {
              kind: "verification_result_changed",
              value: {
                command: verification.command,
                exitCode: verification.exitCode,
                output: verification.output,
                passed: verification.passed,
              },
            },
          });
          this.appendDiagnosticStep("turn_progress", {
            turn: this.turnRequester.currentTurnSequence,
            ...progress,
          });
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
    let pauseMessage: string;
    if (reason === "repeated_error") {
      pauseMessage = `No progress detected; task paused after ${repeatCount} consecutive tool calls failed with identical error: "${detail ?? ""}".`;
    } else if (reason === "semantic_stall") {
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
    await this.emit("log", {
      message: `${tokenBudgetMessage(loop, budget)} Send "继续" to resume with a fresh budget.`,
    });
  }

  private appendDiagnosticStep(kind: string, payload: Record<string, unknown>): number | undefined {
    const taskId = this.activeTask?.id;
    if (!taskId) return undefined;
    return this.trace.appendStep(taskId, kind, payload);
  }

  /** 消息入列后视为不可变;按对象身份缓存深克隆,同步只对新消息付费。 */
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
    const filtered = messages.filter((message) => message.role !== "system" || message.metadata?.contextManaged === true);
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

  private async verify(task: Task): Promise<import("./types.js").VerificationResult> {
    transitionTask(task, "verifying");
    await this.persist(task);
    const commands = this.config.verifyCommands ?? Verifier.inferCommands(task.workspace);
    const results = this.config.skipVerify
      ? [{ command: "(skipped)", exitCode: 0, output: "Verification skipped by user.", durationMs: 0, passed: true }]
      : await this.verifier.runMany(commands, this.abortController?.signal);
    this.throwIfCancelled();
    const result = results.find((candidate) => !candidate.passed) ??
      results.at(-1) ?? {
        command: "(none)",
        exitCode: 0,
        output: "No test/lint command configured; verification skipped.",
        durationMs: 0,
        passed: true,
      };
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
      this.logger(`event callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
