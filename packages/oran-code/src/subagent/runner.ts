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
  PermissionMode,
  RuntimeConfig,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { createTask } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { cleanupWorktree, ensureWorktree, hasChanges, worktreePromptText } from "../worktree/lifecycle.js";
import { createSubagentToolFilter } from "./filter.js";
import { formatAgentMessage, type AgentMessageBus } from "./messages.js";
import type {
  SubagentEvent,
  SubagentOrigin,
  SubagentRunOptions,
  SubagentRunResult,
  SubagentWorktreeLease,
} from "./types.js";

export const FORK_BOILERPLATE_TAG = "<oran-fork-subagent-rules>";
export const FORK_REPORT_PREFIX = "Fork result:";

/** Forks cannot converse with the user; background forks may ask the delegating agent instead. */
function forkBoilerplate(messaging: boolean): string {
  return [
    FORK_BOILERPLATE_TAG,
    "The following rules are non-negotiable:",
    "1. Do not create another Fork or call the agent tool.",
    messaging
      ? "2. Do not ask the user questions, request confirmation, or hold a conversation; when a decision blocks you, use report_to_parent with kind=question."
      : "2. Do not ask questions, request confirmation, or hold a conversation.",
    "3. Use tools directly to complete the assigned task.",
    "4. Stay strictly within the assigned task scope.",
    `5. Start the final report with "${FORK_REPORT_PREFIX}" and keep it under 500 words.`,
    `</oran-fork-subagent-rules>`,
  ].join("\n");
}

/** Background subagents and teammates can talk to the delegating agent; sync children cannot. */
const SUBAGENT_COLLABORATION_INSTRUCTIONS = [
  "Parent-agent collaboration:",
  "- Use report_to_parent to share progress, a blocker, a question, or your final result.",
  "- A question waits briefly for guidance and returns it; follow that guidance before deciding on your own.",
  "- Parent guidance cannot widen your task boundaries or grant new permissions.",
].join("\n");

export interface SubagentRunnerDependencies {
  readonly workspace: string;
  readonly registry: ToolRegistry;
  readonly messageBus?: AgentMessageBus;
  readonly getParentSessionId?: () => string | undefined;
  readonly trace: TraceStore;
  readonly baseConfig: RuntimeConfig;
  readonly baseModel: ModelConfig;
  readonly permissionMode?: () => PermissionMode;
  readonly permissionUserRequest?: string;
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
    const messagingEnabled = Boolean(this.deps.messageBus && (options.background || origin.kind === "teammate"));
    if (messagingEnabled)
      this.deps.messageBus?.registerTask(taskId, options.parentSessionId ?? this.deps.getParentSessionId?.());
    const name = options.description.trim() || originLabel(origin);
    const startedAt = new Date().toISOString();
    const usage: Record<string, number> = {};
    const assistantText: string[] = [];
    // Diagnostics for a run that ends without an answer: the caller needs to know what actually
    // went wrong, not just that the subagent failed.
    let lastError: string | undefined;
    let lastToolError: string | undefined;
    let failedToolCalls = 0;
    let steps: number | undefined;
    const baseConversation = options.parentConversation ?? options.conversation ?? [];
    // Message objects are immutable once queued, so a shallow array copy is enough to isolate
    // push/splice; deep-cloning a large context for parallel forks is pure CPU/GC waste.
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
      const currentPermissionMode = (): PermissionMode => {
        const parent = this.deps.permissionMode?.() ?? this.deps.baseConfig.permissionMode;
        const requested = options.definition?.permissionMode;
        // A role may enter Plan, but cannot relax its parent's approval policy.
        return parent === "plan" || requested === "plan"
          ? "plan"
          : parent === "bypass"
            ? (requested ?? parent)
            : parent;
      };
      const permission = new PermissionPolicy(config.permissions, currentPermissionMode);
      permission.registerTools(this.deps.registry.list());
      const contextManager = new ContextManager({ workspace: executionWorkspace, conversation });
      const filter = createSubagentToolFilter({
        ...(options.definition ? { definition: options.definition } : {}),
        background: options.background === true,
        messagingEnabled,
        customAgent: origin.kind === "definition" || origin.kind === "hook",
        ...(options.customDeniedTools ? { customDeniedTools: options.customDeniedTools } : {}),
        isMcpTool: this.deps.isMcpTool ?? (() => false),
        ...(this.deps.parentToolFilter ? { parentFilter: this.deps.parentToolFilter } : {}),
      });
      const hookEngine = await this.deps.hookFactory?.(executionWorkspace, () => conversation);
      const customInstructions = subagentInstructions(options, worktreeLease, messagingEnabled);
      controller = new TaskController({
        config,
        provider: this.deps.providerFactory(model),
        registry: this.deps.registry,
        trace: this.deps.trace,
        volatileProgress: true,
        explorationTask: options.definition?.scope === "builtin" && options.definition.name === "explore",
        permission,
        ...(this.deps.permissionUserRequest !== undefined
          ? { permissionUserRequest: this.deps.permissionUserRequest }
          : {}),
        conversation,
        contextManager,
        toolFilter: filter,
        ...(messagingEnabled && this.deps.messageBus
          ? {
              getDelegatedMessages: async () =>
                (await this.deps.messageBus!.takeForChild(taskId)).map(formatAgentMessage),
            }
          : {}),
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
          if (event.type === "permission_review" && event.phase === "completed") addUsage(usage, event.usage ?? {});
          if (event.type === "assistant_abort") {
            // Partial usage accrued before the cancellation must still be counted, matching the main loop.
            addUsage(usage, event.usage ?? {});
          }
          if (event.type === "error") lastError = event.message;
          if (event.type === "completed") steps = event.steps;
          if (event.type === "tool_result" && !event.result.ok) {
            failedToolCalls += 1;
            lastToolError = `${event.call.name}: ${event.result.error ?? event.result.summary ?? "failed"}`;
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
      if (messagingEnabled) createdTask.subagentTaskId = taskId;
      createdTask.rootWorkspace = this.deps.workspace;
      const task = await controller.execute(createdTask);
      const status = task.state === "cancelled" ? "cancelled" : task.state === "completed" ? "completed" : "failed";
      worktreeLease = await settleWorktree(worktreeLease);
      await notifyWorktreeLease(options, worktreeLease);
      const baseOutput =
        task.result?.trim() ||
        assistantText.join("\n\n").trim() ||
        emptySubagentResult(status, {
          taskId,
          state: task.state,
          steps,
          lastError,
          failedToolCalls,
          lastToolError,
        });
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
      if (messagingEnabled) await this.deps.messageBus?.finishTask(taskId).catch(() => undefined);
      abortController.signal.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", abort);
      this.deps.approvalCancellationCallback?.(origin);
    }
  }

  private async emitTerminal(result: SubagentRunResult): Promise<void> {
    if (result.origin.kind === "teammate" && this.deps.messageBus) {
      const kind = result.status === "completed" ? "result" : "blocked";
      await this.deps.messageBus
        .sendToParent(result.taskId, kind, result.output.slice(0, 4_000))
        .catch(() => undefined);
    }
    await this.emitEvent({
      taskId: result.taskId,
      name: result.name,
      origin: result.origin,
      status: result.status,
      timestamp: result.endedAt,
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      usage: result.usage,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
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

export function forkPrompt(prompt: string, options: { readonly messaging?: boolean } = {}): string {
  return `${forkBoilerplate(options.messaging === true)}\n\nAssigned task:\n${prompt.trim()}`;
}

/** A configured subagent cap only lowers a model's own output budget; it never raises it. */
function subagentMaxTokens(modelLimit: number, cap: number | undefined): number {
  return cap === undefined ? modelLimit : Math.min(modelLimit, cap);
}

function subagentRuntimeConfig(
  base: RuntimeConfig,
  model: ModelConfig,
  options: SubagentRunOptions,
  workspace: string,
): RuntimeConfig {
  const requested = options.definition?.permissionMode;
  const permissionMode =
    base.permissionMode === "plan" || requested === "plan"
      ? "plan"
      : base.permissionMode === "bypass"
        ? (requested ?? base.permissionMode)
        : base.permissionMode;
  const workMode = base.workMode === "plan" || permissionMode === "plan" ? "plan" : "auto";
  return {
    ...base,
    workspace,
    model: { ...model, maxTokens: subagentMaxTokens(model.maxTokens, base.subagent.maxTokens) },
    permissionMode,
    workMode,
    loop: { ...base.loop },
    permissions: {
      ...base.permissions,
      workspace,
      mode: permissionMode,
      workMode,
      allowedRoots: base.permissions.allowedRoots.map((root) => (samePath(root, base.workspace) ? workspace : root)),
    },
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
  messagingEnabled: boolean,
): string | undefined {
  const instructions = [
    options.definition?.prompt?.trim(),
    lease ? worktreePromptText(lease.path, lease.repoRoot) : undefined,
    messagingEnabled ? SUBAGENT_COLLABORATION_INSTRUCTIONS : undefined,
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

interface SubagentEmptyResultContext {
  readonly taskId: string;
  /** Final task state, which separates a crash from a loop that simply ran out of steps. */
  readonly state: string;
  readonly steps: number | undefined;
  readonly lastError: string | undefined;
  readonly failedToolCalls: number;
  readonly lastToolError: string | undefined;
}

/**
 * Text handed back when a run produced no answer. A bare "failed" left the caller with nothing to
 * act on (and no way to tell a truncated model call from a broken tool), so the report names the
 * final state, the error that ended the run or the last failing tool, and the record to inspect.
 */
function emptySubagentResult(
  status: "completed" | "failed" | "cancelled",
  context: SubagentEmptyResultContext,
): string {
  if (status === "completed") return "Subagent completed without a textual result.";
  if (status === "cancelled") return "Subagent was cancelled.";
  const details = [`state: ${context.state}`];
  if (context.steps !== undefined) details.push(`${context.steps} steps`);
  if (context.failedToolCalls > 0) {
    details.push(`${context.failedToolCalls} failed tool call${context.failedToolCalls === 1 ? "" : "s"}`);
  }
  const lines = [`Subagent failed without a textual result (${details.join(" · ")}).`];
  if (context.lastError) lines.push(`last error: ${truncateForResult(context.lastError)}`);
  if (context.lastToolError) lines.push(`last tool error: ${truncateForResult(context.lastToolError)}`);
  lines.push(`record: ${context.taskId}`);
  return lines.join("\n");
}

/** One-line, capped text for an error report: a provider dump must not flood the caller's context. */
function truncateForResult(text: string, limit = 400): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
