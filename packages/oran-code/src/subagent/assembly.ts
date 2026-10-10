import type { Message, ModelConfig, Task } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { SubagentRunner, type SubagentRunnerDependencies } from "./runner.js";
import { StructuredSubagentScope } from "./scope.js";
import { SubagentCoordinator } from "./coordinator.js";
import type { AgentDefinitionLoader } from "./roles.js";
import type { BackgroundAgentTaskManager } from "./background.js";
import type { TeamManager } from "./team.js";

/**
 * Shared assembly entry point for the main task and the subagent runtime.
 *
 * The interactive session and the non-interactive agent.ts reuse the same assembly order
 * (runner → scope → coordinator.registerTools), and every difference is expressed through
 * runnerDeps and toggle parameters, so the two assembly sites cannot drift into different
 * behaviour over time.
 */
export interface SubagentStackOptions {
  readonly roles: AgentDefinitionLoader;
  readonly background: BackgroundAgentTaskManager;
  readonly teams: TeamManager;
  readonly registry: ToolRegistry;
  readonly runnerDeps: SubagentRunnerDependencies;
  /** Whether to create the structured-fork wait scope (joining every fork before the task wraps up). */
  readonly joinStructuredForks: boolean;
  readonly forkWaitTimeoutMs: number;
  readonly parentConversation: () => readonly Message[];
  readonly resolveModel: (reference: string) => ModelConfig;
}

export interface SubagentStack {
  readonly runner: SubagentRunner;
  readonly scope: StructuredSubagentScope | undefined;
}

export function assembleSubagentStack(options: SubagentStackOptions): SubagentStack {
  const runner = new SubagentRunner(options.runnerDeps);
  const scope = options.joinStructuredForks
    ? new StructuredSubagentScope(runner, options.forkWaitTimeoutMs)
    : undefined;
  new SubagentCoordinator({
    roles: options.roles,
    runner,
    background: options.background,
    teams: options.teams,
    parentConversation: options.parentConversation,
    ...(scope ? { scope } : {}),
    resolveModel: options.resolveModel,
    callerOrigin: { kind: "main" },
  }).registerTools(options.registry);
  return { runner, scope };
}

/** Wait for the structured forks to wrap up and append their execution summary to the task result. */
export async function joinStructuredForkSummaries(
  scope: StructuredSubagentScope,
  task: Task,
  timeoutMs: number,
): Promise<void> {
  await scope.waitForChildren(timeoutMs);
  const summary = scope.summary();
  if (summary) {
    task.result = task.result?.trim() ? `${task.result.trim()}\n\n${summary}` : summary;
  }
}

/** Cancel every fork in the scope and wait for its promise to settle. */
export async function disposeStructuredScope(scope: StructuredSubagentScope): Promise<void> {
  scope.cancelAll();
  await Promise.allSettled(scope.list().map((task) => task.promise));
}
