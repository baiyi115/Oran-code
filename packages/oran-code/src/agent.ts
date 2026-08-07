import type { AgentEvent, AgentOptions, Task } from "./types.js";
import { createModelProvider } from "./provider.js";
import { registerBuiltinTools, ToolRegistry } from "./tools.js";
import { createRuntimeConfig } from "./runtime.js";
import { createTask } from "./types.js";
import { InMemoryTraceStore } from "./trace.js";
import { TaskController } from "./controller.js";

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
): Promise<import("./types.js").Task> {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, options.workspace);
  return executeWithController(options, registry, configOverrides);
}

async function executeWithController(
  options: AgentOptions,
  registry: ToolRegistry,
  configOverrides: { skipVerify?: boolean } = {},
): Promise<Task> {
  const provider = createModelProvider(options.model);
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
  const onEvent = options.onEvent;
  const controller = new TaskController({
    config,
    provider,
    registry,
    trace,
    ...(options.approve ? { approvalCallback: async (call, level) => options.approve?.(call, level) ?? false } : {}),
    ...(onEvent ? { eventCallback: (event) => forwardRuntimeEvent(event, onEvent) } : {}),
    ...(options.stablePromptModules ? { stablePromptModules: options.stablePromptModules } : {}),
  });
  return controller.execute(createTask(options.workspace, options.prompt));
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
  else if (event.type === "completed") emit({ type: "completed", steps: event.steps });
}
