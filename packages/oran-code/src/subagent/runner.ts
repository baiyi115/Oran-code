import { randomUUID } from "node:crypto";
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
  RuntimeEvent,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { createTask } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { createSubagentToolFilter } from "./filter.js";
import type { SubagentEvent, SubagentOrigin, SubagentRunOptions, SubagentRunResult } from "./types.js";

export const FORK_BOILERPLATE_TAG = "<oran-fork-subagent-rules>";
export const FORK_REPORT_PREFIX = "Fork result:";
export const FORK_BOILERPLATE = [
  FORK_BOILERPLATE_TAG,
  "The following rules are non-negotiable:",
  "1. Do not create another Fork or call the agent tool.",
  "2. Do not ask questions, request confirmation, or hold a conversation.",
  "3. Use tools directly to complete the assigned task.",
  "4. Stay strictly within the assigned task scope.",
  `5. Start the final report with \"${FORK_REPORT_PREFIX}\" and keep it under 500 words.`,
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
  readonly hookFactory?: (messages: () => readonly Message[]) => Promise<HookEnginePort | undefined>;
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
    let conversation = structuredClone([...baseConversation]);
    let controller: TaskController | undefined;
    const abort = (): void => controller?.cancel();
    abortController.signal.addEventListener("abort", abort, { once: true });
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const model = options.model ?? (options.definition?.model
        ? this.deps.resolveModel(options.definition.model)
        : this.deps.baseModel);
      const config = subagentRuntimeConfig(this.deps.baseConfig, model, options);
      const permission = new PermissionPolicy(config.permissions);
      permission.registerTools(this.deps.registry.list());
      const contextManager = new ContextManager({ workspace: this.deps.workspace, conversation });
      const filter = createSubagentToolFilter({
        ...(options.definition ? { definition: options.definition } : {}),
        background: options.background === true,
        customAgent: origin.kind === "definition" || origin.kind === "hook",
        ...(options.customDeniedTools ? { customDeniedTools: options.customDeniedTools } : {}),
        isMcpTool: this.deps.isMcpTool ?? (() => false),
        ...(this.deps.parentToolFilter ? { parentFilter: this.deps.parentToolFilter } : {}),
      });
      const hookEngine = await this.deps.hookFactory?.(() => conversation);
      controller = new TaskController({
        config,
        provider: this.deps.providerFactory(model),
        registry: this.deps.registry,
        trace: this.deps.trace,
        permission,
        conversation,
        contextManager,
        toolFilter: filter,
        ...(options.definition ? {
          stablePromptModules: { customInstructions: options.definition.prompt },
        } : {}),
        ...(hookEngine ? { hookEngine } : {}),
        approvalCallback: (call, level, description, requestId) => (
          this.deps.approvalCallback?.(call, level, description, requestId, origin) ?? false
        ),
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
          conversation = structuredClone([...messages]);
        },
        hookUserPrompt: options.prompt,
      });
      if (abortController.signal.aborted || options.signal?.aborted) controller.cancel();
      const task = await controller.execute(createTask(this.deps.workspace, options.prompt));
      const status = task.state === "cancelled" ? "cancelled" : task.state === "completed" ? "completed" : "failed";
      const output = task.result?.trim() || assistantText.join("\n\n").trim() || stableEmptyResult(status);
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
      };
      await this.emitTerminal(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SubagentRunResult = {
        taskId,
        name,
        origin,
        status: abortController.signal.aborted || options.signal?.aborted ? "cancelled" : "failed",
        output: message || "Subagent failed without an error message.",
        ...(message ? { error: message } : {}),
        usage: { ...usage },
        startedAt,
        endedAt: new Date().toISOString(),
        conversation: controller?.conversationSnapshot() ?? conversation,
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

function subagentRuntimeConfig(base: RuntimeConfig, model: ModelConfig, options: SubagentRunOptions): RuntimeConfig {
  const permissionMode = options.definition?.permissionMode ?? base.permissionMode;
  const workMode = options.definition?.workMode ?? (permissionMode === "plan" ? "plan" : base.workMode);
  return {
    ...base,
    model: { ...model },
    permissionMode,
    workMode,
    loop: {
      ...base.loop,
      ...(options.definition?.maxSteps !== undefined ? { maxSteps: options.definition.maxSteps } : {}),
    },
    permissions: {
      ...base.permissions,
      mode: permissionMode,
      workMode,
      allowedRoots: [...base.permissions.allowedRoots],
    },
    skipVerify: true,
  };
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
