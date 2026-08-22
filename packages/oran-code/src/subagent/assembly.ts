import type { Message, ModelConfig, Task } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { SubagentRunner, type SubagentRunnerDependencies } from "./runner.js";
import { StructuredSubagentScope } from "./scope.js";
import { SubagentCoordinator } from "./coordinator.js";
import type { AgentDefinitionLoader } from "./roles.js";
import type { BackgroundAgentTaskManager } from "./background.js";
import type { TeamManager } from "./team.js";

/**
 * 主任务与子代理运行时的共享装配入口。
 *
 * 交互式 session 与非交互 agent.ts 复用同一装配顺序(runner → scope →
 * coordinator.registerTools),差异全部通过 runnerDeps 与开关参数表达,
 * 防止两处装配随时间漂移出不同的行为。
 */
export interface SubagentStackOptions {
  readonly roles: AgentDefinitionLoader;
  readonly background: BackgroundAgentTaskManager;
  readonly teams: TeamManager;
  readonly registry: ToolRegistry;
  readonly runnerDeps: SubagentRunnerDependencies;
  /** 是否创建结构化 fork 等待域(任务收尾前 join 全部 fork)。 */
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

/** 等待结构化 fork 收尾,并把执行摘要附加到任务结果。 */
export async function joinStructuredForkSummaries(scope: StructuredSubagentScope, task: Task, timeoutMs: number): Promise<void> {
  await scope.waitForChildren(timeoutMs);
  const summary = scope.summary();
  if (summary) {
    task.result = task.result?.trim()
      ? `${task.result.trim()}\n\n${summary}`
      : summary;
  }
}

/** 取消 scope 内全部 fork 并等待其 promise 落定。 */
export async function disposeStructuredScope(scope: StructuredSubagentScope): Promise<void> {
  scope.cancelAll();
  await Promise.allSettled(scope.list().map((task) => task.promise));
}
