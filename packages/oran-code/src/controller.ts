import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { AgentLoop } from "./loop.js";
import { ContextManager } from "./context-manager.js";
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
  ToolCall,
  ToolDefinition,
  ToolKind,
  ToolResult,
  OptionalSystemPromptModules,
} from "./types.js";
import { transitionTask } from "./types.js";
import { formatErrorMessage } from "./error-format.js";
import { isCasualConversationPrompt } from "./prompt-intent.js";
import { isMutatingToolName, isPlanModeTool, isWriteToolName, type ToolRegistry } from "./tools.js";
import {
  buildEnvironmentPrompt,
  assembleStableSystemPrompt,
  environmentSystemMessage,
  loopBudgetReminder,
  stableSystemMessage,
  systemReminderMessage,
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
  conversation?: Message[];
  contextManager?: ContextManager;
  stablePromptModules?: OptionalSystemPromptModules;
  runtimeReminders?: () => readonly string[];
  toolFilter?: (tool: ToolDefinition) => boolean;
}

/** Explicit plan-complete markers the model may emit to finish plan mode. */
const PLAN_COMPLETE_MARKERS = [
  "PLAN_COMPLETE",
  "<<PLAN_COMPLETE>>",
  "<plan_complete>",
  "</plan_complete>",
] as const;

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
  private readonly contextManager: ContextManager;
  private readonly stablePromptModules: OptionalSystemPromptModules;
  private readonly runtimeReminders: () => readonly string[];
  private readonly toolFilter: (tool: ToolDefinition) => boolean;
  private abortController: AbortController | undefined;
  private activeTask: Task | undefined;
  private sequence = 0;
  private turnSequence = 0;
  private conversation: Message[];

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
    this.conversation = cloneMessages(options.conversation ?? []);
    this.contextManager = options.contextManager ?? new ContextManager({
      workspace: options.config.workspace,
      conversation: this.conversation,
    });
    this.stablePromptModules = { ...options.stablePromptModules };
    this.runtimeReminders = options.runtimeReminders ?? (() => []);
    this.toolFilter = options.toolFilter ?? (() => true);
  }

  cancel(): void {
    this.abortController?.abort();
  }

  conversationSnapshot(): Message[] {
    return cloneMessages(this.conversation);
  }

  async execute(task: Task): Promise<Task> {
    if (this.activeTask) throw new Error("task controller is already executing");
    this.activeTask = task;
    this.abortController = new AbortController();
    this.sequence = 0;
    this.turnSequence = 0;
    const loop = new AgentLoop(this.config.loop);
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
      this.activeTask = undefined;
      this.abortController = undefined;
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
        appVersion: "0.1.0",
      })),
      ...turnConversation,
    ];
    this.syncConversation(messages);

    let workspaceMutated = false;
    while (loop.canContinue()) {
      this.throwIfCancelled();
      loop.recordTurn();
      const finalTurn = loop.isFinalTurn();
      const reminders = [
        taskModeReminder(planMode, loop.turns),
        loopBudgetReminder(loop.remainingTurns(), finalTurn),
        ...this.runtimeReminders(),
      ];
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
          await this.emit("completed", { steps: Math.max(1, loop.turns), tokensUsed: loop.tokensUsed });
          return task;
        }
        this.throwIfCancelled();
        task.result = response.text;
        transitionTask(task, "completed");
        await this.persist(task);
        this.throwIfCancelled();
        await this.emit("completed", { steps: Math.max(1, loop.turns), tokensUsed: loop.tokensUsed });
        return task;
      }
      if (response.toolCalls.length) {
        try {
          workspaceMutated ||= await this.runTools(task, messages, response.toolCalls, loop);
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
        await this.emit("completed", { steps: Math.max(1, loop.turns), tokensUsed: loop.tokensUsed });
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
        await this.emit("completed", { steps: Math.max(1, loop.turns), tokensUsed: loop.tokensUsed });
        return task;
      } else {
        const verification = await this.verify(task, messages);
        this.throwIfCancelled();
        if (verification.passed) {
          task.result = response.text;
          transitionTask(task, "completed");
          await this.persist(task);
          this.throwIfCancelled();
          await this.emit("completed", { steps: Math.max(1, loop.turns), tokensUsed: loop.tokensUsed });
          return task;
        }
        messages.push({ role: "user", content: `Verification failed:\n${verification.output}` });
        this.syncConversation(messages);
        transitionTask(task, "executing");
        await this.persist(task);
      }
      if (loop.hasNoProgress()) {
        transitionTask(task, "paused");
        await this.persist(task);
        await this.emit("log", { message: "No progress detected; task paused for review." });
        return task;
      }
    }
    transitionTask(task, "failed");
    await this.persist(task);
    await this.emit("error", {
      message: loop.tokenBudgetReached()
        ? tokenBudgetMessage(loop, this.config.loop.tokenBudget)
        : `Reached the ${this.config.loop.maxSteps}-iteration limit before the task completed.`,
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
    let managedMessages = await this.prepareContext(messages, reminders, tools);
    let requestMessages = withRuntimeReminders(managedMessages, reminders);
    try {
      const response = await this.streamWithRetry(requestMessages, loop, step, source, tools);
      this.contextManager.recordUsage(response.usage, usageAnchorMessages(requestMessages, response), tools);
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
        managedMessages = compacted.messages;
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
    if (!this.contextManager.shouldAutoCompact(requestMessages, contextWindow, tools)) return managedMessages;

    const beforeTokens = this.contextManager.estimateTokens(requestMessages, tools);
    await this.emit("context_compaction", {
      phase: "started",
      reason: "auto",
      beforeTokens,
      replacementCount: 0,
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
      this.syncConversation(managedMessages);
      await this.emit("context_compaction", {
        phase: "completed",
        reason: "auto",
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
        replacementCount: compacted.replacementCount,
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
    // Thought rows are model-adaptive: only open a thought bubble once the provider
    // actually streams reasoning. Many chat models never send reasoning at all.
    let thoughtStarted = false;
    await this.emit("assistant_start", { step, source, attempt, model: this.config.model.model }, turnId);
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const usage: Record<string, number> = {};
    const reasoningParts: string[] = [];
    let streamed = false;
    let finishReason: string | undefined;
    try {
      const providerOptions = this.abortController?.signal
        ? { signal: this.abortController.signal }
        : undefined;
      for await (const chunk of this.provider.streamResponse(messages, tools, providerOptions)) {
        streamed ||= chunk.streamed;
        if (chunk.reasoning) {
          if (!thoughtStarted) {
            thoughtStarted = true;
            await this.emit("thought_start", { step, source, attempt }, turnId);
          }
          reasoningParts.push(chunk.reasoning);
          await this.emit("thought_delta", { step, source, attempt, text: chunk.reasoning }, turnId);
        }
        if (chunk.text) {
          textParts.push(chunk.text);
          await this.emit("assistant_delta", { step, source, attempt, text: chunk.text }, turnId);
        }
        if (chunk.toolCalls?.length) toolCalls.push(...chunk.toolCalls);
        if (chunk.usage) Object.assign(usage, chunk.usage);
        if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
      }
      loop.recordUsage(usage);
      const normalizedCalls = toolCalls.map((call) => normalizeCallId(call, this.contextManager));
      const response: ModelResponse = {
        text: textParts.join(""),
        ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
        toolCalls: normalizedCalls,
        raw: { usage, finishReason, toolCalls: normalizedCalls },
        usage,
        streamed,
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
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
      await this.emit("assistant_abort", { step, source, attempt, message: formatErrorMessage(error), ...(finishReason !== undefined ? { finishReason } : {}) }, turnId);
      if (aborted && (textParts.length || toolCalls.length || reasoningParts.length)) {
        // Preserve partial assistant output so conversation history stays usable after cancel.
        loop.recordUsage(usage);
        const normalizedCalls = toolCalls.map((call) => normalizeCallId(call, this.contextManager));
        return {
          text: textParts.join(""),
          ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
          toolCalls: normalizedCalls,
          raw: { usage, finishReason, toolCalls: normalizedCalls, aborted: true },
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
        if (this.config.workMode === "plan") {
          await this.recordTool(task, messages, call, index, planModeDeniedResult(call), 0);
          continue;
        }
        const denied = await this.authorizeTool(task, call, 4, "command", "Unknown tool requested by the model.");
        if (denied) {
          await this.recordTool(task, messages, call, index, denied, 0);
          continue;
        }
        const result: ToolResult = {
          ok: false,
          output: "",
          error: `unknown tool: ${call.name}`,
          summary: "unknown tool",
        };
        loop.recordUnknownTool(call);
        await this.recordTool(task, messages, call, index, result, 0);
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
        loop.record(call);
        prepared.push({ index, call });
      }

      const executable = prepared.filter((item) => !item.skip);
      const results = new Map<number, { call: ToolCall; result: ToolResult; duration: number; mutated: boolean }>();
      for (let offset = 0; offset < executable.length; offset += concurrency) {
        this.throwIfCancelled();
        const slice = executable.slice(offset, offset + concurrency);
        await Promise.all(slice.map(async (item) => {
          const started = Date.now();
          const beforeWorkspace = isPotentiallyMutating(item.call) ? await workspaceFingerprint(task.workspace) : undefined;
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
          results.set(item.index, { call: item.call, result: { ...result, durationMs: duration }, duration, mutated });
        }));
      }

      // Write back in original model order (skipped + executed).
      for (const item of prepared) {
        if (item.skip) {
          await this.recordTool(task, messages, item.call, item.index, item.skip, 0);
          continue;
        }
        const entry = results.get(item.index);
        if (!entry) continue;
        if (entry.mutated) workspaceMutated = true;
        if (entry.result.ok && entry.call.name === "read_file") {
          await this.trackSuccessfulFileRead(task.workspace, entry.call);
        }
        await this.recordTool(task, messages, entry.call, item.index, entry.result, entry.duration);
        this.logger(`Tool ${entry.call.name}: ${entry.result.summary ?? entry.result.ok}`);
      }
      this.throwIfCancelled();
    }
    return workspaceMutated;
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
    for (const [index, call] of calls.entries()) {
      const id = ensureCallId(call, this.contextManager);
      if (pairedIds.has(id)) continue;
      await this.recordTool(task, messages, call, index, {
        ok: false,
        output: "",
        error: reason,
        summary: cancelled ? "cancelled" : "not completed",
        metadata: { ...(cancelled ? { cancelled: true } : {}), reconciled: true },
      }, 0);
      pairedIds.add(id);
    }
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

  private async recordTool(task: Task, messages: Message[], call: ToolCall, index: number, result: ToolResult, duration: number): Promise<void> {
    const output = result.output || result.error || "";
    this.trace.appendToolCall(task.id, call.name, call.arguments, output, result.ok, duration);
    await this.emit("tool_result", { call, index, result: { ...result, durationMs: duration } });
    messages.push({ role: "tool", content: output || "(empty result)", toolCallId: call.id ?? `call_${call.name}`, name: call.name });
    this.syncConversation(messages);
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
    const results = this.config.skipVerify
      ? [{ command: "(skipped)", exitCode: 0, output: "Verification skipped by user.", durationMs: 0, passed: true }]
      : await this.verifier.runMany(Verifier.inferCommands(task.workspace), this.abortController?.signal);
    this.throwIfCancelled();
    const result = results[0] ?? { command: "(none)", exitCode: 0, output: "No test/lint command configured; verification skipped.", durationMs: 0, passed: true };
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

  private async emit<K extends keyof RuntimeEventPayloads>(type: K, payload: RuntimeEventPayloads[K], turnId?: string): Promise<void> {
    const base = { version: 1 as const, type, taskId: this.activeTask?.id ?? "unknown", sequence: ++this.sequence, timestamp: new Date().toISOString(), ...payload };
    const event = turnId === undefined ? base : { ...base, turnId };
    try { await this.eventCallback(event as RuntimeEvent); } catch (error) { this.logger(`event callback failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private toolSchemasForMode(): Record<string, unknown>[] {
    return this.registry.schemas((tool) => (
      this.isToolVisible(tool)
      && (this.config.workMode !== "plan" || isPlanModeTool(tool))
    ));
  }

  private isToolVisible(tool: ToolDefinition): boolean {
    return tool.system === true || this.toolFilter(tool);
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function ensureCallId(call: ToolCall, contextManager: ContextManager): string {
  if (call.id) return call.id;
  const id = contextManager.claimToolCallId();
  call.id = id;
  return id;
}

function normalizeCallId(call: ToolCall, contextManager: ContextManager): ToolCall {
  return { ...call, id: contextManager.claimToolCallId(call.id) };
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
    "Start a new session or use /clear to reduce prior context, lower the reasoning effort, or increase agent.tokenBudget.",
  ].join(" ");
}

function withRuntimeReminders(messages: readonly Message[], reminders: readonly string[]): Message[] {
  const copy = cloneMessages(messages);
  const insertionIndex = copy.findIndex((message) => message.role !== "system");
  copy.splice(insertionIndex < 0 ? copy.length : insertionIndex, 0, systemReminderMessage(reminders));
  return copy;
}

function usageAnchorMessages(messages: readonly Message[], response: ModelResponse): Message[] {
  return [
    ...messages,
    { role: "assistant", content: response.text, toolCalls: response.toolCalls },
  ];
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

function isPotentiallyMutating(call: ToolCall): boolean {
  return isMutatingToolName(call.name);
}

function inferToolKind(name: string): "readonly" | "write" | "command" {
  if (isWriteToolName(name)) return "write";
  if (["list_files", "read_file", "glob_files", "search_code", "git_status", "get_diff"].includes(name)) return "readonly";
  return "command";
}

async function workspaceFingerprint(root: string): Promise<string> {
  const entries: string[] = [];
  await collectWorkspaceEntries(resolve(root), resolve(root), entries);
  return entries.sort().join("\n");
}

async function collectWorkspaceEntries(root: string, directory: string, entries: string[]): Promise<void> {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (FINGERPRINT_IGNORED.has(child.name)) continue;
    const path = resolve(directory, child.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (child.isDirectory()) {
      entries.push(`d:${relativePath}`);
      await collectWorkspaceEntries(root, path, entries);
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
