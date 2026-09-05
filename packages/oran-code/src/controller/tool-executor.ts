import type { ContextManager } from "../context-manager.js";
import { CONTEXT_LIMITS } from "../context-manager.js";
import type { PermissionPolicy } from "../security.js";
import type { TraceStore } from "../trace.js";
import type { SnapshotStorePort } from "../snapshot.js";
import type {
  ApprovalResponse,
  HookEventPortContext,
  Message,
  RuntimeConfig,
  RuntimeEventPayloads,
  Task,
  TaskPlanState,
  TaskPlanStep,
  ToolCall,
  ToolDefinition,
  ToolKind,
  ToolResult,
} from "../types.js";
import { transitionTask } from "../types.js";
import type { AgentLoop } from "../loop.js";
import { toolCallSignature } from "../loop.js";
import type { ToolRegistry } from "../tools.js";
import { isMutatingToolName, isPlanModeTool } from "../tools.js";
import {
  BATCH_TOOL_NAME,
  formatBatchScriptResult,
  parseBatchScript,
  substituteStepArguments,
  type BatchScriptSpec,
  type BatchStepOutcome,
  type BatchStepSpec,
} from "../tools/batch-tools.js";
import { formatErrorMessage } from "../error-format.js";
import { isAbortError } from "../utils/abort-error.js";
import {
  ensureCallId,
  extractToolFilePath,
  fileHash,
  inferToolKind,
  permissionDeniedResult,
  planModeDeniedResult,
  summarizeArguments,
  toolUnavailableResult,
  workspaceSnapshot,
  diffWorkspaceEntries,
} from "../controller-utils.js";

interface DeferredToolRecord {
  call: ToolCall;
  index: number;
  result: ToolResult;
  duration: number;
  executed: boolean;
}

export interface ToolBatchExecutionSummary {
  workspaceMutated: boolean;
  readonlyOnly: boolean;
}

/**
 * 工具执行器与 TaskController 之间的端口。controller 保留事件、持久化、
 * hook、可见性过滤等横切能力,executor 只负责批量编排与结果记录。
 */
export interface ToolExecutorPorts {
  readonly config: RuntimeConfig;
  readonly registry: ToolRegistry;
  readonly contextManager: ContextManager;
  readonly trace: TraceStore;
  readonly permission: PermissionPolicy;
  readonly logger: (message: string) => void;
  readonly debugLogger: (message: string) => void;
  readonly readonlyCache: Map<string, ToolResult>;
  readonly snapshotStore: SnapshotStorePort | undefined;
  readonly snapshotSessionId: string | undefined;
  emit<K extends keyof RuntimeEventPayloads>(type: K, payload: RuntimeEventPayloads[K]): Promise<void>;
  persist(task: Task): Promise<void>;
  requestApproval(call: ToolCall, level: number, description: string): Promise<ApprovalResponse>;
  fireHook(ctx: HookEventPortContext): Promise<void>;
  checkBeforeToolHook(task: Task, call: ToolCall): Promise<ToolResult | undefined>;
  isToolVisible(tool: ToolDefinition): boolean;
  syncConversation(messages: readonly Message[]): void;
  appendDiagnosticStep(kind: string, payload: Record<string, unknown>): number | undefined;
  trackSuccessfulFileRead(workspace: string, call: ToolCall): Promise<void>;
  throwIfCancelled(): void;
  getLoop(): AgentLoop | undefined;
  getAbortSignal(): AbortSignal | undefined;
  getTurnSequence(): number;
  getModelResponseStepId(): number | undefined;
}

/**
 * 工具批执行器:连续 readonly 调用并发成批、写/命令串行、审批前置、
 * 结果延迟记录(整批结束后统一卸载)。从 TaskController 提取,行为不变。
 */
export class ToolBatchExecutor {
  private deferredRecords: DeferredToolRecord[] | undefined;

  constructor(private readonly ports: ToolExecutorPorts) {}

  async runTools(
    task: Task,
    messages: Message[],
    calls: ToolCall[],
    loop: AgentLoop,
  ): Promise<ToolBatchExecutionSummary> {
    let workspaceMutated = false;
    const readonlyOnly =
      calls.length > 0 &&
      calls.every((call) => {
        if (!this.ports.registry.has(call.name)) return false;
        const tool = this.ports.registry.get(call.name);
        return (tool.kind ?? inferToolKind(call.name)) === "readonly";
      });
    const concurrency = Math.max(1, this.ports.config.loop.readonlyConcurrency || 1);
    const deferredRecords: DeferredToolRecord[] = [];
    this.deferredRecords = deferredRecords;

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
        ensureCallId(call, this.ports.contextManager);
        const known = this.ports.registry.has(call.name);
        const kind = known ? (this.ports.registry.get(call.name).kind ?? inferToolKind(call.name)) : "command";
        if (known && kind === "readonly") {
          readonlyBatch.push({ index, call });
        } else {
          flushReadonly();
          batches.push([{ index, call }]);
        }
      }
      flushReadonly();

      for (const batch of batches) {
        this.ports.throwIfCancelled();
        if (batch.length === 1 && !this.ports.registry.has(batch[0]!.call.name)) {
          const { index, call } = batch[0]!;
          await this.ports.emit("tool_start", { call, index, permissionLevel: 4 });
          const hookBlock = await this.ports.checkBeforeToolHook(task, call);
          if (hookBlock) {
            await this.recordTool(task, messages, call, index, hookBlock, 0, { executed: false });
            continue;
          }
          if (this.ports.config.workMode === "plan") {
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
          this.ports.logger(`Tool ${call.name}: unknown tool`);
          if (loop.shouldStopForUnknownTools()) return { workspaceMutated, readonlyOnly };
          continue;
        }

        // batch_tools 脚本:由执行器特判解释,每个步骤走完整的单调用管线,
        // 结果折叠成一条聚合 tool 消息,不再逐调用产生模型轮次。
        if (batch.length === 1 && batch[0]!.call.name === BATCH_TOOL_NAME) {
          const { index, call } = batch[0]!;
          const batchMutated = await this.runBatchScript(task, messages, call, index, loop);
          workspaceMutated ||= batchMutated;
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
          this.ports.throwIfCancelled();
          const { index, call } = item;
          const tool = this.ports.registry.get(call.name);
          const kind = tool.kind ?? inferToolKind(call.name);
          await this.ports.emit("tool_start", { call, index, permissionLevel: tool.permissionLevel });
          const hookBlock = await this.ports.checkBeforeToolHook(task, call);
          if (hookBlock) {
            prepared.push({ index, call, skip: hookBlock });
            continue;
          }
          if (!this.ports.isToolVisible(tool)) {
            prepared.push({ index, call, skip: toolUnavailableResult(call) });
            continue;
          }
          if (this.ports.config.workMode === "plan" && !isPlanModeTool(tool)) {
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
          const cacheKey = kind === "readonly" && tool.cacheable !== false ? toolCallSignature(call) : undefined;
          if (cacheKey && this.ports.readonlyCache.has(cacheKey)) {
            const cached = this.ports.readonlyCache.get(cacheKey)!;
            this.ports.debugLogger(
              JSON.stringify({
                event: "tool_cached_duplicate",
                taskId: task.id,
                turn: this.ports.getTurnSequence(),
                index,
                tool: call.name,
                arguments: summarizeArguments(call.arguments),
              }),
            );
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
        if (
          this.ports.snapshotStore &&
          this.ports.snapshotSessionId &&
          executable.some((item) => this.isPotentiallyMutating(item.call))
        ) {
          try {
            await this.ports.snapshotStore.begin(this.ports.snapshotSessionId, task);
          } catch (error) {
            this.ports.debugLogger(
              JSON.stringify({ event: "snapshot_begin_failed", taskId: task.id, error: formatErrorMessage(error) }),
            );
          }
        }
        const results = new Map<number, { call: ToolCall; result: ToolResult; duration: number; mutated: boolean }>();
        // 指纹按批取前后各一次;逐调用前后各跑一次 git status 在大仓库上代价过高。
        // snapshot 同时携带状态行列表,用于生成执行回执。
        const batchBefore = executable.some((item) => this.isPotentiallyMutating(item.call))
          ? await workspaceSnapshot(task.workspace)
          : undefined;
        for (let offset = 0; offset < executable.length; offset += concurrency) {
          this.ports.throwIfCancelled();
          const slice = executable.slice(offset, offset + concurrency);
          await Promise.all(
            slice.map(async (item) => {
              const started = Date.now();
              this.ports.debugLogger(
                JSON.stringify({
                  event: "tool_execute_start",
                  taskId: task.id,
                  turn: this.ports.getTurnSequence(),
                  index: item.index,
                  callId: item.call.id,
                  tool: item.call.name,
                  arguments: summarizeArguments(item.call.arguments),
                }),
              );
              const before = await fileHash(task.workspace, item.call);
              let result: ToolResult;
              try {
                const executionContext = this.ports.getAbortSignal()
                  ? { workspace: task.workspace, signal: this.ports.getAbortSignal()! }
                  : { workspace: task.workspace };
                result = await this.ports.registry.invoke(item.call, executionContext);
              } catch (error) {
                if (isAbortError(error) || this.ports.getAbortSignal()?.aborted) {
                  result = {
                    ok: false,
                    output: "",
                    error: "tool cancelled",
                    summary: "cancelled",
                    metadata: { cancelled: true },
                  };
                } else {
                  result = { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
                }
              }
              const duration = Date.now() - started;
              const after = await fileHash(task.workspace, item.call);
              if (before && after && before.hash !== after.hash) {
                this.ports.trace.appendFileChange(task.id, before.path, before.hash, after.hash);
              }
              result = await this.offloadLargeToolResult(task, item.call, result);
              const executedResult = { ...result, durationMs: duration };
              const tool = this.ports.registry.get(item.call.name);
              if (
                result.ok &&
                (tool.kind ?? inferToolKind(item.call.name)) === "readonly" &&
                tool.cacheable !== false
              ) {
                const cacheKey = toolCallSignature(item.call);
                this.ports.readonlyCache.set(cacheKey, {
                  ...executedResult,
                  metadata: { ...executedResult.metadata, cached: false },
                });
              }
              results.set(item.index, { call: item.call, result: executedResult, duration, mutated: false });
            }),
          );
        }
        const batchAfter = batchBefore === undefined ? undefined : await workspaceSnapshot(task.workspace);
        if (batchBefore !== undefined && batchAfter !== undefined && batchBefore.fingerprint !== batchAfter.fingerprint) {
          for (const entry of results.values()) {
            if (this.isPotentiallyMutating(entry.call)) entry.mutated = true;
          }
        }

        // Write back in original model order (skipped + executed).
        for (const item of prepared) {
          if (item.skip) {
            await this.recordTool(task, messages, item.call, item.index, item.skip, 0, { executed: false });
            continue;
          }
          const entry = results.get(item.index);
          if (!entry) continue;
          if (entry.mutated) {
            workspaceMutated = true;
            if (batchBefore && batchAfter) {
              entry.result = withWorkspaceChangesReceipt(entry.result, batchBefore.entries, batchAfter.entries);
            }
          }
          if (entry.result.ok && this.isPotentiallyMutating(entry.call)) this.ports.readonlyCache.clear();
          if (entry.result.ok && entry.call.name === "read_file") {
            await this.ports.trackSuccessfulFileRead(task.workspace, entry.call);
          }
          await this.recordTool(task, messages, entry.call, item.index, entry.result, entry.duration);
          this.ports.logger(`Tool ${entry.call.name}: ${entry.result.summary ?? entry.result.ok}`);
        }
        this.ports.throwIfCancelled();
      }
      return { workspaceMutated, readonlyOnly };
    } finally {
      try {
        await this.flushDeferredToolRecords(task, messages, deferredRecords);
      } finally {
        if (this.deferredRecords === deferredRecords) this.deferredRecords = undefined;
      }
    }
  }

  /**
   * 解释执行 batch_tools 调用:步骤按序执行,前序输出供后续参数引用;失败
   * 按脚本的 on_failure 策略处理。取消时抛出中断,由上层 reconcile 统一补
   * 齐消息配对。返回值指示脚本是否改动了工作区。
   */
  private async runBatchScript(
    task: Task,
    messages: Message[],
    call: ToolCall,
    index: number,
    loop: AgentLoop,
  ): Promise<boolean> {
    let script: BatchScriptSpec;
    try {
      script = parseBatchScript(call.arguments);
    } catch (error) {
      await this.recordTool(task, messages, call, index, {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        summary: "invalid batch_tools script",
      }, 0, { executed: false });
      return false;
    }
    if (!loop.canRecordToolCall()) {
      await this.recordTool(task, messages, call, index, {
        ok: false,
        output: "",
        error: "tool call budget exhausted before batch_tools could run",
        summary: "budget exhausted",
      }, 0, { executed: false });
      return false;
    }
    loop.record(call);
    // 脚本自身的开始标记行:步骤行之前给出 batch_tools 调用,聚合结果在最后闭合。
    await this.ports.emit("tool_start", {
      call,
      index,
      permissionLevel: this.ports.registry.get(BATCH_TOOL_NAME).permissionLevel,
    });
    const startedAt = Date.now();
    const stepOutputs = new Map<string, string>();
    const outcomes: BatchStepOutcome[] = [];
    let workspaceMutated = false;
    let abortedAt: string | undefined;
    for (const [stepIndex, step] of script.steps.entries()) {
      this.ports.throwIfCancelled();
      const execution = await this.executeBatchStep(task, messages, step, stepIndex, loop, stepOutputs);
      workspaceMutated ||= execution.mutated;
      outcomes.push(execution.outcome);
      if (!execution.outcome.ok) {
        if (execution.cancelled) this.ports.throwIfCancelled();
        if (script.onFailure === "abort") {
          abortedAt = step.id;
          break;
        }
      }
    }
    const durationMs = Date.now() - startedAt;
    const formatted = formatBatchScriptResult({
      steps: outcomes,
      total: script.steps.length,
      onFailure: script.onFailure,
      durationMs,
      ...(abortedAt !== undefined ? { abortedAt } : {}),
    });
    const result: ToolResult = formatted.output.length <= 16_000
      ? formatted
      : { ...formatted, output: `${formatted.output.slice(0, 11_200)}\n...[truncated]...\n${formatted.output.slice(-4_000)}` };
    await this.recordTool(task, messages, call, index, result, durationMs);
    return workspaceMutated;
  }

  /**
   * 脚本单步执行:镜像单调用批处理的准备与执行语义(hook、可见性、计划模式、
   * 授权、只读缓存、文件指纹),但结果不写入消息流——步骤输出仅进入聚合结
   * 果,由 batch_tools 的单条 tool 消息回传,保持 assistant/toolCalls 配对。
   */
  private async executeBatchStep(
    task: Task,
    messages: Message[],
    step: BatchStepSpec,
    index: number,
    loop: AgentLoop,
    stepOutputs: Map<string, string>,
  ): Promise<{ outcome: BatchStepOutcome; mutated: boolean; cancelled: boolean }> {
    const tool = this.ports.registry.has(step.tool) ? this.ports.registry.get(step.tool) : undefined;
    const kind = tool ? (tool.kind ?? inferToolKind(step.tool)) : "command";
    const call: ToolCall = {
      name: step.tool,
      // 校验后的脚本参数本身是对象;替换只发生在值内部,结构保持 Record。
      arguments: substituteStepArguments(step.arguments, (id) => stepOutputs.get(id)) as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    ensureCallId(call, this.ports.contextManager);
    await this.ports.emit("tool_start", { call, index, permissionLevel: tool?.permissionLevel ?? 4 });
    const complete = async (
      result: ToolResult,
      duration: number,
      mutated = false,
      cancelled = false,
      executed = true,
    ): Promise<{ outcome: BatchStepOutcome; mutated: boolean; cancelled: boolean }> => {
      stepOutputs.set(step.id, result.output || "");
      const outcome: BatchStepOutcome = {
        id: step.id,
        tool: step.tool,
        ok: result.ok,
        ...(duration > 0 ? { durationMs: duration } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.output ? { output: result.output } : {}),
        ...(!result.ok || !result.output ? (result.summary ? { summary: result.summary } : {}) : {}),
      };
      await this.recordToolNow(task, messages, call, index, result, duration, executed, { scriptStep: true });
      return { outcome, mutated, cancelled };
    };
    const hookBlock = await this.ports.checkBeforeToolHook(task, call);
    if (hookBlock) return complete(hookBlock, 0, false, false, false);
    if (!tool) {
      loop.recordUnknownTool(call);
      return complete({ ok: false, output: "", error: `unknown tool: ${call.name}`, summary: "unknown tool" }, 0, false, false, false);
    }
    if (!this.ports.isToolVisible(tool)) return complete(toolUnavailableResult(call), 0, false, false, false);
    if (this.ports.config.workMode === "plan" && !isPlanModeTool(tool)) {
      return complete(planModeDeniedResult(call), 0, false, false, false);
    }
    const denied = tool.system
      ? undefined
      : await this.authorizeTool(task, call, tool.permissionLevel, kind, tool.description);
    if (denied) return complete(denied, 0, false, false, false);
    const cacheKey = kind === "readonly" && tool.cacheable !== false ? toolCallSignature(call) : undefined;
    if (cacheKey && this.ports.readonlyCache.has(cacheKey)) {
      const cached = this.ports.readonlyCache.get(cacheKey)!;
      loop.record(call);
      return complete({ ...cached, metadata: { ...cached.metadata, cached: true } }, 0, false, false, false);
    }
    if (!loop.canRecordToolCall()) {
      return complete({ ok: false, output: "", error: "tool call budget exhausted", summary: "budget exhausted" }, 0, false, false, false);
    }
    loop.record(call);
    const started = Date.now();
    const beforeWorkspace = this.isPotentiallyMutating(call)
      ? await workspaceSnapshot(task.workspace)
      : undefined;
    const before = await fileHash(task.workspace, call);
    let result: ToolResult;
    try {
      const executionContext = this.ports.getAbortSignal()
        ? { workspace: task.workspace, signal: this.ports.getAbortSignal()! }
        : { workspace: task.workspace };
      result = await this.ports.registry.invoke(call, executionContext);
    } catch (error) {
      if (isAbortError(error) || this.ports.getAbortSignal()?.aborted) {
        result = { ok: false, output: "", error: "tool cancelled", summary: "cancelled", metadata: { cancelled: true } };
      } else {
        result = { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
      }
    }
    const duration = Date.now() - started;
    const after = await fileHash(task.workspace, call);
    const afterWorkspace =
      beforeWorkspace === undefined ? undefined : await workspaceSnapshot(task.workspace);
    const mutated =
      beforeWorkspace !== undefined &&
      afterWorkspace !== undefined &&
      beforeWorkspace.fingerprint !== afterWorkspace.fingerprint;
    if (mutated && beforeWorkspace && afterWorkspace) {
      result = withWorkspaceChangesReceipt(result, beforeWorkspace.entries, afterWorkspace.entries);
    }
    if (before && after && before.hash !== after.hash) {
      this.ports.trace.appendFileChange(task.id, before.path, before.hash, after.hash);
    }
    if (result.ok && kind === "readonly" && tool.cacheable !== false && cacheKey) {
      this.ports.readonlyCache.set(cacheKey, {
        ...result,
        durationMs: duration,
        metadata: { ...result.metadata, cached: false },
      });
    }
    if (result.ok && this.isPotentiallyMutating(call)) this.ports.readonlyCache.clear();
    if (result.ok && call.name === "read_file") await this.ports.trackSuccessfulFileRead(task.workspace, call);
    return complete({ ...result, durationMs: duration }, duration, mutated, result.metadata?.cancelled === true);
  }

  async reconcileToolCalls(
    task: Task,
    messages: Message[],
    calls: readonly ToolCall[],
    reason: string,
    cancelled: boolean,
  ): Promise<void> {
    const pairedIds = new Set(
      messages.filter((message) => message.role === "tool" && message.toolCallId).map((message) => message.toolCallId!),
    );
    const blockedBeforeExecution = !cancelled && reason.includes("blocked before execution");
    for (const [index, call] of calls.entries()) {
      const id = ensureCallId(call, this.ports.contextManager);
      if (pairedIds.has(id)) continue;
      await this.recordTool(
        task,
        messages,
        call,
        index,
        {
          ok: false,
          output: "",
          error: reason,
          summary: cancelled ? "cancelled" : blockedBeforeExecution ? "blocked before execution" : "not completed",
          metadata: {
            ...(cancelled ? { cancelled: true } : {}),
            ...(blockedBeforeExecution ? { blockedBeforeExecution: true } : {}),
            reconciled: true,
          },
        },
        0,
        { executed: false },
      );
      pairedIds.add(id);
    }
  }

  isPotentiallyMutating(call: ToolCall): boolean {
    const tool = this.ports.registry.has(call.name) ? this.ports.registry.get(call.name) : undefined;
    return tool ? (tool.kind ?? inferToolKind(call.name)) !== "readonly" : isMutatingToolName(call.name);
  }

  private async authorizeTool(
    task: Task,
    call: ToolCall,
    level: number,
    kind: ToolKind,
    description: string,
  ): Promise<ToolResult | undefined> {
    const decision = await this.ports.permission.decide(call, level, kind);
    if (decision.verdict === "allow") return undefined;
    if (decision.verdict === "deny") return permissionDeniedResult(call, decision);

    const resumeState = task.state === "planning" ? "planning" : "executing";
    transitionTask(task, "awaiting_approval");
    await this.ports.persist(task);
    let approval: ApprovalResponse;
    try {
      approval = await this.ports.requestApproval(call, level, `${description}\nReason: ${decision.reason}`);
    } finally {
      if (task.state === "awaiting_approval" && !this.ports.getAbortSignal()?.aborted) {
        transitionTask(task, resumeState);
        await this.ports.persist(task);
      }
    }
    this.ports.throwIfCancelled();

    if (approval === true) return undefined;
    if (approval === "task") {
      this.ports.permission.allowForTask(call);
      return undefined;
    }
    if (approval === "always") {
      try {
        await this.ports.permission.allowPermanently(call);
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

  async recordTool(
    task: Task,
    messages: Message[],
    call: ToolCall,
    index: number,
    result: ToolResult,
    duration: number,
    options: { executed?: boolean } = {},
  ): Promise<void> {
    const deferredRecords = this.deferredRecords;
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
    const offload = await this.ports.contextManager.offloadToolResults(
      records.map((record) => ({
        id: record.call.id ?? `call_${record.call.name}`,
        content: record.result.output || record.result.error || "",
      })),
    );
    if (offload.offloadedCount > 0 || offload.failedCount > 0) {
      const payload: RuntimeEventPayloads["context_compaction"] = {
        phase: "offloaded",
        reason: "auto",
        replacementCount: offload.offloadedCount,
      };
      if (offload.failedCount > 0) payload.message = `${offload.failedCount} tool result(s) could not be offloaded.`;
      await this.ports.emit("context_compaction", payload);
    }
    for (const record of records) {
      const replacement = offload.replacements.get(record.call.id ?? `call_${record.call.name}`);
      const result =
        replacement === undefined
          ? record.result
          : {
              ...record.result,
              output: replacement,
              ...(record.result.error ? { error: "tool failed; details offloaded" } : {}),
              metadata: {
                ...record.result.metadata,
                offloaded: true,
                originalBytes:
                  record.result.metadata?.originalBytes ??
                  Buffer.byteLength(record.result.output || record.result.error || "", "utf8"),
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
    const offload = await this.ports.contextManager.offloadToolResults([{ id, content }]);
    const replacement = offload.replacements.get(id);
    if (replacement === undefined) return result;
    await this.ports.emit("context_compaction", {
      phase: "offloaded",
      reason: "auto",
      replacementCount: 1,
      ...(offload.failedCount > 0 ? { message: "A large tool result could not be offloaded." } : {}),
    });
    this.ports.debugLogger(
      JSON.stringify({
        event: "tool_result_offloaded_immediately",
        taskId: task.id,
        turn: this.ports.getTurnSequence(),
        callId: call.id,
        tool: call.name,
        originalBytes: bytes,
      }),
    );
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
    options: { scriptStep?: boolean } = {},
  ): Promise<void> {
    const output = result.output || result.error || "";
    this.ports.getLoop()?.recordResult(call, result);
    if (call.name === "update_plan" && result.ok && result.output) {
      try {
        const parsed = JSON.parse(result.output) as {
          goal?: string;
          steps?: TaskPlanStep[];
          currentStepIndex?: number;
        };
        if (parsed && typeof parsed.goal === "string" && Array.isArray(parsed.steps)) {
          const planState: TaskPlanState = {
            goal: parsed.goal,
            steps: parsed.steps,
            currentStepIndex: parsed.currentStepIndex ?? 0,
            updatedAt: new Date().toISOString(),
          };
          task.planState = planState;
          await this.ports.persist(task);
          await this.ports.emit("task_plan_updated", { planState });
        }
      } catch (error) {
        this.ports.debugLogger(
          JSON.stringify({
            event: "update_plan_parse_failed",
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    this.ports.trace.appendToolCall(
      task.id,
      call.name,
      call.arguments,
      output,
      result.ok,
      duration,
      this.ports.getModelResponseStepId(),
    );
    await this.ports.emit("tool_result", { call, index, result: { ...result, durationMs: duration } });
    if (executed) {
      await this.ports.fireHook({
        event: "after_tool_call",
        workspace: task.workspace,
        model: this.ports.config.model.model,
        tool: call,
        filePath: extractToolFilePath(call),
      });
    }
    if (!options.scriptStep) {
      messages.push({
        role: "tool",
        content: output || "(empty result)",
        toolCallId: call.id ?? `call_${call.name}`,
        name: call.name,
      });
      this.ports.syncConversation(messages);
    }
    this.ports.appendDiagnosticStep("tool_result", {
      step: this.ports.getTurnSequence(),
      index,
      callId: call.id,
      tool: call.name,
      arguments: summarizeArguments(call.arguments),
      ok: result.ok,
      outputBytes: Buffer.byteLength(output, "utf8"),
      resultAppended: !options.scriptStep,
      executed,
      scriptStep: options.scriptStep === true,
      metadata: result.metadata,
    });
    this.ports.debugLogger(
      JSON.stringify({
        event: "tool_result",
        taskId: task.id,
        turn: this.ports.getTurnSequence(),
        index,
        callId: call.id,
        tool: call.name,
        arguments: summarizeArguments(call.arguments),
        ok: result.ok,
        outputBytes: Buffer.byteLength(output, "utf8"),
        resultAppended: true,
        executed,
        metadata: result.metadata,
      }),
    );
  }
}

const WORKSPACE_CHANGES_RECEIPT_LIMIT = 40;

/** 变异调用后把工作区变更清单追加到结果尾部,省去模型下一轮的探查调用。 */
function withWorkspaceChangesReceipt(
  result: ToolResult,
  before: readonly string[],
  after: readonly string[],
): ToolResult {
  const changes = diffWorkspaceEntries(before, after);
  if (!changes.length) return result;
  const listed = changes.slice(0, WORKSPACE_CHANGES_RECEIPT_LIMIT).join("\n");
  const suffix =
    changes.length > WORKSPACE_CHANGES_RECEIPT_LIMIT
      ? `${listed}\n...[${changes.length - WORKSPACE_CHANGES_RECEIPT_LIMIT} more]`
      : listed;
  const base = result.output?.trimEnd() ?? "";
  return {
    ...result,
    output: `${base}${base ? "\n\n" : ""}<workspace-changes>\n${suffix}\n</workspace-changes>`,
  };
}
