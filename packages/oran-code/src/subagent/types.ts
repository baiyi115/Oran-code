import type {
  Message,
  ModelConfig,
  PermissionMode,
  RuntimeEvent,
  ToolResult,
  WorkMode,
} from "../types.js";

export type AgentDefinitionScope = "builtin" | "user" | "project";
export type AgentIsolationMode = "shared-workspace" | "worktree";
export type StructuredSubagentStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type PersistedSubagentStatus = StructuredSubagentStatus | "interrupted";

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly model?: string;
  readonly maxSteps?: number;
  readonly permissionMode?: PermissionMode;
  readonly workMode?: WorkMode;
  readonly forceBackground?: boolean;
  readonly isolationMode?: AgentIsolationMode;
  readonly skills?: readonly string[];
  readonly memory?: boolean;
  readonly mcpServers?: readonly string[];
  readonly scope: AgentDefinitionScope;
  readonly filePath?: string;
}

export type SubagentOrigin =
  | { readonly kind: "main" }
  | { readonly kind: "definition"; readonly name: string; readonly taskId?: string }
  | { readonly kind: "fork"; readonly name: string; readonly taskId?: string }
  | { readonly kind: "hook"; readonly name: string; readonly taskId?: string }
  | { readonly kind: "teammate"; readonly name: string; readonly teamName: string; readonly taskId?: string };

export function subagentOriginLabel(origin: SubagentOrigin): string {
  switch (origin.kind) {
    case "main":
      return "Main Agent";
    case "definition":
      return `Subagent: ${origin.name}`;
    case "fork":
      return `Fork: ${origin.name}`;
    case "hook":
      return `Hook subagent: ${origin.name}`;
    case "teammate":
      return `Teammate: ${origin.teamName}/${origin.name}`;
  }
}

export interface SubagentWorktreeLease {
  readonly slug: string;
  readonly path: string;
  readonly branch: string;
  readonly baseline: string;
  readonly repoRoot: string;
}

export interface SubagentRunOptions {
  readonly description: string;
  readonly prompt: string;
  readonly origin: SubagentOrigin;
  readonly definition?: AgentDefinition;
  readonly model?: ModelConfig;
  readonly parentConversation?: readonly Message[];
  readonly conversation?: readonly Message[];
  readonly background?: boolean;
  readonly customDeniedTools?: readonly string[];
  readonly continueAfterParentExit?: boolean;
  readonly signal?: AbortSignal;
  readonly taskId?: string;
  readonly abortController?: AbortController;
  /** Reuse a retained worktree instead of creating a new one. */
  readonly worktreeLease?: SubagentWorktreeLease;
  /** Persist lease changes while the task is still running for crash recovery. */
  readonly worktreeLeaseCallback?: (lease: SubagentWorktreeLease | undefined) => void | Promise<void>;
}

export interface SubagentEvent {
  readonly taskId: string;
  readonly name: string;
  readonly origin: SubagentOrigin;
  readonly status: StructuredSubagentStatus;
  readonly timestamp: string;
  readonly runtimeEvent?: RuntimeEvent;
  readonly output?: string;
  readonly error?: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface SubagentRunResult {
  readonly taskId: string;
  readonly name: string;
  readonly origin: SubagentOrigin;
  readonly status: Exclude<StructuredSubagentStatus, "running" | "timed_out">;
  readonly output: string;
  readonly error?: string;
  readonly usage: Readonly<Record<string, number>>;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly conversation: readonly Message[];
  readonly workspace: string;
  readonly worktreeLease?: SubagentWorktreeLease;
}

export interface StructuredSubagentTask {
  readonly id: string;
  readonly name: string;
  readonly origin: SubagentOrigin;
  readonly startedAt: string;
  endedAt?: string;
  status: StructuredSubagentStatus;
  output?: string;
  error?: string;
  usage: Readonly<Record<string, number>>;
  readonly abortController: AbortController;
  readonly promise: Promise<SubagentRunResult>;
}

export interface BackgroundAgentTask {
  readonly id: string;
  readonly name: string;
  readonly origin: SubagentOrigin;
  readonly startedAt: string;
  endedAt?: string;
  status: PersistedSubagentStatus;
  output?: string;
  error?: string;
  usage: Readonly<Record<string, number>>;
  notified: boolean;
  readonly prompt: string;
  readonly definitionName?: string;
  readonly modelReference?: string;
  worktreeLease?: SubagentWorktreeLease;
  readonly retryOf?: string;
  readonly abortController?: AbortController;
  readonly promise?: Promise<SubagentRunResult>;
}

export interface AgentToolArguments {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly run_in_background?: boolean;
  readonly team_name?: string;
}

export interface UnsupportedSubagentOperation {
  readonly code: "unsupported_operation";
  readonly operation: "continue_after_parent_exit";
  readonly message: string;
}

export interface TeamMemberSnapshot {
  readonly name: string;
  readonly status: "idle" | "running" | "stopped" | "failed" | "interrupted";
  readonly queuedMessages: number;
  readonly toolCount: number;
  readonly lastOutput?: string;
  readonly lastError?: string;
}

export interface TeamSnapshot {
  readonly name: string;
  readonly members: readonly TeamMemberSnapshot[];
}

export interface TeamMessageResult {
  readonly ok: boolean;
  readonly output: string;
  readonly result?: ToolResult;
}
