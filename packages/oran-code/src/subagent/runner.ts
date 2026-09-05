import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ContextManager } from "../context-manager.js";
import { TaskController } from "../controller.js";
import { PermissionPolicy } from "../security.js";
import type { TraceStore } from "../trace.js";
import type {
  ApprovalResponse,
  HookEnginePort,
  Message,
  ModelConfig,
  ModelProvider,
  RuntimeConfig,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { createTask } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { cleanupWorktree, ensureWorktree, hasChanges, worktreePromptText } from "../worktree/lifecycle.js";
import { createSubagentToolFilter } from "./filter.js";
import type {
  SubagentEvent,
  SubagentOrigin,
  SubagentRunOptions,
  SubagentRunResult,
  SubagentWorktreeLease,
} from "./types.js";

export const FORK_BOILERPLATE_TAG = "<oran-fork-subagent-rules>";
export const FORK_REPORT_PREFIX = "Fork result:";
export const FORK_BOILERPLATE = [
  FORK_BOILERPLATE_TAG,
  "The following rules are non-negotiable:",
  "1. Do not create another Fork or call the agent tool.",
  "2. Do not ask questions, request confirmation, or hold a conversation.",
  "3. Use tools directly to complete the assigned task.",
  "4. Stay strictly within the assigned task scope.",
  `5. Start the final report with "${FORK_REPORT_PREFIX}" and keep it under 500 words.`,
  `</oran-fork-subagent-rules>`,
].join("\n");

export interface SubagentRunnerDependencies {
  readonly workspace: string;
  readonly registry: ToolRegistry;
  readonly trace: TraceStore;
  readonly baseConfig: RuntimeConfig;
  readonly baseModel: ModelConfig;
  readonly providerFactory: (model: ModelConfig) => ModelProvider;
  readonly resolveModel: (reference: string) => ModelConfig;
  readonly approvalCallback?: (
    call: ToolCall,
    level: number,
    description: string,
    requestId: string,
    origin: SubagentOrigin,
  ) => ApprovalResponse | Promise<ApprovalResponse>;
  readonly eventCallback?: (event: SubagentEvent) => void | Promise<void>;
  readonly approvalCancellationCallback?: (origin: SubagentOrigin) => void;
  readonly parentToolFilter?: (tool: ToolDefinition) => boolean;
  readonly isMcpTool?: (name: string) => boolean;
  readonly hookFactory?: (workspace: string, messages: () => readonly Message[]) => Promise<HookEnginePort | undefined>;
}

export class SubagentRunner {
  constructor(private readonly deps: SubagentRunnerDependencies) {}

  async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
    const taskId = options.taskId ?? `subagent-${randomUUID()}`;
    const abortController = options.abortController ?? new AbortController();
    const origin = withTaskId(options.origin, taskId);
    const name = options.description.trim() || originLabel(origin);
    const startedAt = new Date().toISOString();
    const usage: Record<string, number> = {};
    const assistantText: string[] = [];
    const baseConversation = options.parentConversation ?? options.conversation ?? [];
    // 消息对象入列后不可变,浅拷贝数组即可隔离 push/splice;对大上下文做
    // 深克隆对并行 fork 是纯粹的 CPU/GC 浪费。
    let conversation = [...baseConversation];
    let controller: TaskController | undefined;
    let executionWorkspace = this.deps.workspace;
    let worktreeLease = options.worktreeLease;
    const abort = (): void => controller?.cancel();
    abortController.signal.addEventListener("abort", abort, { once: true });
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.definition?.isolationMode === "worktree" || worktreeLease) {
        const ensured = await ensureWorktree(this.deps.workspace, worktreeLease?.slug ?? worktreeSlug(taskId));
        executionWorkspace = ensured.info.path;
        worktreeLease = {
          slug: worktreeLease?.slug ?? worktreeSlug(taskId),
          path: ensured.info.path,
          branch: ensured.info.branch,
          baseline: worktreeLease?.baseline ?? ensured.info.head,
          repoRoot: ensured.info.repoRoot,
        };
        await notifyWorktreeLease(options, worktreeLease);
      }
      const model =
        options.model ??
        (options.definition?.model ? this.deps.resolveModel(options.definition.model) : this.deps.baseModel);
      const config = subagentRuntimeConfig(this.deps.baseConfig, model, options, executionWorkspace);
      const permission = new PermissionPolicy(config.permissions);
      permission.registerTools(this.deps.registry.list());
      const contextManager = new ContextManager({ workspace: executionWorkspace, conversation });
      const filter = createSubagentToolFilter({
        ...(options.definition ? { definition: options.definition } : {}),
        background: options.background === true,
        customAgent: origin.kind === "definition" || origin.kind === "hook",
        ...(options.customDeniedTools ? { customDeniedTools: options.customDeniedTools } : {}),
        isMcpTool: this.deps.isMcpTool ?? (() => false),
        ...(this.deps.parentToolFilter ? { parentFilter: this.deps.parentToolFilter } : {}),
      });
      const hookEngine = await this.deps.hookFactory?.(executionWorkspace, () => conversation);
      const customInstructions = subagentInstructions(options, worktreeLease);
      controller = new TaskController({
        config,
        provider: this.deps.providerFactory(model),
        registry: this.deps.registry,
        trace: this.deps.trace,
        permission,
        conversation,
        contextManager,
        toolFilter: filter,
        ...(customInstructions
          ? {
              stablePromptModules: { customInstructions },
            }
          : {}),
        ...(hookEngine ? { hookEngine } : {}),
        approvalCallback: (call, level, description, requestId) =>
          this.deps.approvalCallback?.(call, level, description, requestId, origin) ?? false,
        eventCallback: async (event) => {
          if (event.type === "assistant_end") {
            if (event.text.trim()) assistantText.push(event.text.trim());
            addUsage(usage, event.usage);
          }
          await this.emitEvent({
            taskId,
            name,
            origin,
            status: "running",
            timestamp: new Date().toISOString(),
            runtimeEvent: event,
            usage: { ...usage },
          });
        },
        conversationCallback: (messages) => {
          conversation = [...messages];
        },
        hookUserPrompt: options.prompt,
      });
      if (abortController.signal.aborted || options.signal?.aborted) controller.cancel();
      const createdTask = createTask(executionWorkspace, options.prompt);
      createdTask.id = taskId;
      createdTask.rootWorkspace = this.deps.workspace;
      const task = await controller.execute(createdTask);
      const status = task.state === "cancelled" ? "cancelled" : task.state === "completed" ? "completed" : "failed";
      worktreeLease = await settleWorktree(worktreeLease);
      await notifyWorktreeLease(options, worktreeLease);
      const baseOutput = task.result?.trim() || assistantText.join("\n\n").trim() || stableEmptyResult(status);
      const output = appendWorktreeSummary(baseOutput, worktreeLease);
      const result: SubagentRunResult = {
        taskId,
        name,
        origin,
        status,
        output,
        ...(status === "failed" ? { error: output } : {}),
        usage: { ...usage },
        startedAt,
        endedAt: new Date().toISOString(),
        conversation: controller.conversationSnapshot(),
        workspace: executionWorkspace,
        ...(worktreeLease ? { worktreeLease } : {}),
      };
      await this.emitTerminal(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      worktreeLease = await settleWorktree(worktreeLease);
      await notifyWorktreeLease(options, worktreeLease);
      const output = appendWorktreeSummary(message || "Subagent failed without an error message.", worktreeLease);
      const result: SubagentRunResult = {
        taskId,
        name,
        origin,
        status: abortController.signal.aborted || options.signal?.aborted ? "cancelled" : "failed",
        output,
        ...(message ? { error: message } : {}),
        usage: { ...usage },
        startedAt,
        endedAt: new Date().toISOString(),
        conversation: controller?.conversationSnapshot() ?? conversation,
        workspace: executionWorkspace,
        ...(worktreeLease ? { worktreeLease } : {}),
      };
      await this.emitTerminal(result);
      return result;
    } finally {
      abortController.signal.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", abort);
      this.deps.approvalCancellationCallback?.(origin);
    }
  }

  private async emitTerminal(result: SubagentRunResult): Promise<void> {
    await this.emitEvent({
      taskId: result.taskId,
      name: result.name,
      origin: result.origin,
      status: result.status,
      timestamp: result.endedAt,
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      usage: result.usage,
    });
  }

  private async emitEvent(event: SubagentEvent): Promise<void> {
    try {
      await this.deps.eventCallback?.(event);
    } catch {
      // Observers cannot change the subagent terminal state.
    }
  }
}

export function containsForkMarker(messages: readonly Message[]): boolean {
  return messages.some((message) => message.content?.includes(FORK_BOILERPLATE_TAG));
}

export function forkPrompt(prompt: string): string {
  return `${FORK_BOILERPLATE}\n\nAssigned task:\n${prompt.trim()}`;
}

function subagentRuntimeConfig(
  base: RuntimeConfig,
  model: ModelConfig,
  options: SubagentRunOptions,
  workspace: string,
): RuntimeConfig {
  const permissionMode = options.definition?.permissionMode ?? base.permissionMode;
  const workMode = options.definition?.workMode ?? (permissionMode === "plan" ? "plan" : base.workMode);
  return {
    ...base,
    workspace,
    model: { ...model },
    permissionMode,
    workMode,
    loop: {
      ...base.loop,
      ...(options.definition?.maxSteps !== undefined ? { maxSteps: options.definition.maxSteps } : {}),
    },
    permissions: {
      ...base.permissions,
      workspace,
      mode: permissionMode,
      workMode,
      allowedRoots: base.permissions.allowedRoots.map((root) => (samePath(root, base.workspace) ? workspace : root)),
    },
    skipVerify: true,
  };
}

function worktreeSlug(taskId: string): string {
  return `agent-${createHash("sha256").update(taskId).digest("hex").slice(0, 20)}`;
}

async function settleWorktree(lease: SubagentWorktreeLease | undefined): Promise<SubagentWorktreeLease | undefined> {
  if (!lease) return undefined;
  if (await hasChanges(lease.path, lease.baseline)) return lease;
  const cleanup = await cleanupWorktree(lease.repoRoot, lease.path, lease.branch);
  return cleanup.ok ? undefined : lease;
}

async function notifyWorktreeLease(
  options: SubagentRunOptions,
  lease: SubagentWorktreeLease | undefined,
): Promise<void> {
  try {
    await options.worktreeLeaseCallback?.(lease);
  } catch {
    // Persistence observers cannot change the subagent terminal state.
  }
}

function subagentInstructions(
  options: SubagentRunOptions,
  lease: SubagentWorktreeLease | undefined,
): string | undefined {
  const instructions = [
    options.definition?.prompt?.trim(),
    lease ? worktreePromptText(lease.path, lease.repoRoot) : undefined,
  ].filter((item): item is string => Boolean(item));
  return instructions.length ? instructions.join("\n\n") : undefined;
}

function appendWorktreeSummary(output: string, lease: SubagentWorktreeLease | undefined): string {
  if (!lease) return output;
  return [
    output,
    "",
    "Worktree retained because it contains changes or cleanup did not complete:",
    `- Path: ${lease.path}`,
    `- Branch: ${lease.branch}`,
    `- Baseline: ${lease.baseline}`,
  ].join("\n");
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left).replace(/[\\/]+$/, "");
  const b = resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withTaskId(origin: SubagentOrigin, taskId: string): SubagentOrigin {
  if (origin.kind === "main") return origin;
  return { ...origin, taskId };
}

function originLabel(origin: SubagentOrigin): string {
  if (origin.kind === "main") return "subagent";
  if (origin.kind === "teammate") return `${origin.teamName}/${origin.name}`;
  return origin.name;
}

function addUsage(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
  for (const [key, value] of Object.entries(source)) {
    if (Number.isFinite(value)) target[key] = (target[key] ?? 0) + value;
  }
}

function stableEmptyResult(status: "completed" | "failed" | "cancelled"): string {
  if (status === "completed") return "Subagent completed without a textual result.";
  if (status === "cancelled") return "Subagent was cancelled.";
  return "Subagent failed without a textual result.";
}
