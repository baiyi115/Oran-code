import type { AgentEvent, AgentOptions, Message, ModelConfig, Task } from "./types.js";
import { createModelProvider } from "./provider.js";
import { registerBuiltinTools, ToolRegistry } from "./tools.js";
import { createRuntimeConfig } from "./runtime.js";
import { createTask } from "./types.js";
import { InMemoryTraceStore } from "./trace.js";
import { TaskController } from "./controller.js";
import { BackgroundAgentTaskManager } from "./subagent/background.js";
import { SubagentCoordinator } from "./subagent/coordinator.js";
import { AgentDefinitionLoader } from "./subagent/roles.js";
import { SubagentRunner } from "./subagent/runner.js";
import { StructuredSubagentScope } from "./subagent/scope.js";
import { TeamManager } from "./subagent/team.js";

export async function runTask(options: AgentOptions, registry: ToolRegistry): Promise<void> {
  await executeWithController(options, registry, { skipVerify: true });
}

/**
 * Controller-backed entry point used by the TypeScript CLI.
 *
 * This convenience entry point registers Oran code's built-in tools. The
 * compatibility runTask API above uses the same controller with its caller's
 * registry, so prompt, permission, context, and cancellation behavior cannot
 * drift into a second loop implementation.
 */
export async function runTaskWithController(
  options: AgentOptions,
  configOverrides: { skipVerify?: boolean } = {},
): Promise<Task> {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, options.workspace);
  return executeWithController(options, registry, configOverrides);
}

async function executeWithController(
  options: AgentOptions,
  registry: ToolRegistry,
  configOverrides: { skipVerify?: boolean } = {},
): Promise<Task> {
  const config = createRuntimeConfig(
    options.workspace,
    options.model,
    {
      providers: {},
      agent: {
        maxSteps: options.maxSteps,
        ...(configOverrides.skipVerify !== undefined ? { skipVerify: configOverrides.skipVerify } : {}),
      },
    },
    options.approveAll,
  );
  const trace = new InMemoryTraceStore();
  const roles = new AgentDefinitionLoader(options.workspace);
  await roles.scan();
  const background = new BackgroundAgentTaskManager();
  const teams = new TeamManager();
  let conversation: Message[] = [];
  const resolveModel = (reference: string): ModelConfig => resolveNonInteractiveModel(reference, options.model);
  const runner = new SubagentRunner({
    workspace: options.workspace,
    registry,
    trace,
    baseConfig: config,
    baseModel: options.model,
    providerFactory: createModelProvider,
    resolveModel,
    ...(options.approve ? {
      approvalCallback: async (call, level) => options.approve?.(call, level) ?? false,
    } : {}),
    ...(options.onEvent ? {
      eventCallback: (event) => {
        if (event.runtimeEvent) forwardRuntimeEvent(event.runtimeEvent, options.onEvent as (event: AgentEvent) => void);
      },
    } : {}),
    parentToolFilter: () => true,
    isMcpTool: () => false,
  });
  const scope = new StructuredSubagentScope(runner, config.subagent.forkWaitTimeoutMs);
  new SubagentCoordinator({
    roles,
    runner,
    background,
    teams,
    parentConversation: () => conversation,
    scope,
    resolveModel,
    callerOrigin: { kind: "main" },
  }).registerTools(registry);
  const controller = new TaskController({
    config,
    provider: createModelProvider(options.model),
    registry,
    trace,
    conversation,
    conversationCallback: (messages) => {
      conversation = structuredClone([...messages]);
    },
    ...(options.approve ? { approvalCallback: async (call, level) => options.approve?.(call, level) ?? false } : {}),
    ...(options.onEvent ? { eventCallback: (event) => forwardRuntimeEvent(event, options.onEvent as (event: AgentEvent) => void) } : {}),
    ...(options.stablePromptModules ? { stablePromptModules: options.stablePromptModules } : {}),
  });
  try {
    const task = await controller.execute(createTask(options.workspace, options.prompt));
    await scope.waitForChildren(config.subagent.forkWaitTimeoutMs);
    const summary = scope.summary();
    if (summary) {
      task.result = task.result?.trim()
        ? `${task.result.trim()}\n\n${summary}`
        : summary;
    }
    return task;
  } finally {
    scope.cancelAll();
    background.cancelAll();
    await Promise.allSettled(scope.list().map((task) => task.promise));
    await teams.shutdown();
    await background.waitForIdle();
  }
}

function resolveNonInteractiveModel(reference: string, current: ModelConfig): ModelConfig {
  const normalized = reference.trim();
  if (normalized === current.model || normalized === `${current.provider}/${current.model}`) return current;
  throw new Error(
    `Model override ${reference} is not configured in the non-interactive AgentOptions. ` +
    `Only ${current.provider}/${current.model} is available.`,
  );
}

function forwardRuntimeEvent(event: import("./types.js").RuntimeEvent, emit: (event: AgentEvent) => void): void {
  if (event.type === "state") emit({ type: "state", state: event.state });
  else if (event.type === "assistant_start") emit({ type: "assistant_start" });
  else if (event.type === "assistant_delta") emit({ type: "assistant_delta", text: event.text });
  else if (event.type === "assistant_end") emit({
    type: "assistant_end",
    text: event.text,
    toolCalls: event.toolCalls,
    streamed: event.streamed,
  });
  else if (event.type === "tool_start") emit({ type: "tool_start", call: event.call, permissionLevel: event.permissionLevel });
  else if (event.type === "tool_result") emit({ type: "tool_result", call: event.call, result: event.result });
  else if (event.type === "error") emit({ type: "error", message: event.message });
  else if (event.type === "completed") emit({ type: "completed", steps: event.steps, tokensUsed: event.tokensUsed });
}
