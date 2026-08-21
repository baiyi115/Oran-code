import { randomUUID } from "node:crypto";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type WorkMode = "plan" | "auto";
export type PermissionMode = "default" | "accept-edits" | "plan" | "bypass";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ToolKind = "readonly" | "write" | "command";
export type SessionTitleMode = "first-message" | "local" | "model";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "accept-edits", "plan", "bypass"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export type TaskState =
  | "created"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export const TERMINAL_TASK_STATES: readonly TaskState[] = ["completed", "failed", "paused", "cancelled"];

export type TaskPlanStepStatus = "pending" | "in_progress" | "completed" | "skipped";

export interface TaskPlanStep {
  id: string;
  title: string;
  status: TaskPlanStepStatus;
  description?: string | undefined;
}

export interface TaskPlanState {
  goal: string;
  steps: TaskPlanStep[];
  currentStepIndex: number;
  updatedAt: string;
}

export interface Task {
  id: string;
  workspace: string;
  /** Root workspace that owns this task when execution happens in a worktree. */
  rootWorkspace?: string;
  prompt: string;
  state: TaskState;
  plan?: string;
  planState?: TaskPlanState;
  model?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelReference {
  provider: string;
  model: string;
}

export function createTask(workspace: string, prompt: string): Task {
  const now = new Date().toISOString();
  return {
    id: `task-${randomUUID()}`,
    workspace,
    rootWorkspace: workspace,
    prompt,
    state: "created",
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionTask(task: Task, state: TaskState): void {
  task.state = state;
  task.updatedAt = new Date().toISOString();
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  createdAt: string;
}

export interface Message {
  role: MessageRole;
  content?: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  raw: Record<string, unknown>;
  usage: Record<string, number>;
  finishReason?: string;
  streamed: boolean;
}

export interface ModelStreamChunk {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: Record<string, number>;
  finishReason?: string;
  streamed: boolean;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
}

export interface ModelProvider {
  complete(
    messages: Message[],
    tools?: Record<string, unknown>[],
    options?: ProviderRequestOptions,
  ): Promise<ModelResponse>;
  streamResponse(
    messages: Message[],
    tools?: Record<string, unknown>[],
    options?: ProviderRequestOptions,
  ): AsyncGenerator<ModelStreamChunk>;
}

export interface ModelConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  temperature: number;
  maxTokens: number;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  options?: Record<string, unknown>;
}

export interface ModelOptions {
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  [key: string]: unknown;
}

export interface ModelProfile {
  name?: string;
  options: ModelOptions;
}

export interface ProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  permission?: string;
  [key: string]: unknown;
}

export interface ProviderProfile {
  npm?: string;
  name?: string;
  options: ProviderOptions;
  models: Record<string, ModelProfile>;
}

export interface AgentSettings {
  approveAll?: boolean;
  skipVerify?: boolean;
  maxSteps?: number;
  tokenBudget?: number;
  workMode?: WorkMode;
  permissionMode?: PermissionMode;
  lastModel?: string;
  /** Explicit verification commands run after workspace mutations. Takes precedence over inferred commands. */
  verifyCommands?: string[];
}

export interface OptionalSystemPromptModules {
  readonly customInstructions?: string;
  readonly activeSkills?: string;
  readonly longTermMemory?: string;
}

export interface SessionTitleSettings {
  mode?: SessionTitleMode;
  model?: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: "sse";
}

export interface SubagentSettings {
  forkWaitTimeoutMs?: number;
}

export interface UserConfig {
  providers: Record<string, ProviderProfile>;
  agent?: AgentSettings;
  subagent?: SubagentSettings;
  sessionTitles?: SessionTitleSettings;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: HookRule[];
}

export interface LoopConfig {
  maxSteps: number;
  maxRetries: number;
  commandTimeout: number;
  noProgressLimit: number;
  tokenBudget: number;
  /** Stop after this many consecutive unknown tool calls. 0 disables. */
  unknownToolLimit: number;
  /** Max concurrent readonly tool calls inside one batch. */
  readonlyConcurrency: number;
}

export interface PermissionConfig {
  workspace: string;
  workMode: WorkMode;
  mode: PermissionMode;
  userRulesPath: string;
  projectRulesPath: string;
  localRulesPath: string;
  planDirectory: string;
  allowedRoots: string[];
}

export interface RuntimeConfig {
  workspace: string;
  model: ModelConfig;
  workMode: WorkMode;
  permissionMode: PermissionMode;
  loop: LoopConfig;
  permissions: PermissionConfig;
  subagent: {
    forkWaitTimeoutMs: number;
  };
  skipVerify: boolean;
  approveAll: boolean;
  traceDb?: string;
  /** Explicit verification commands; falls back to Verifier.inferCommands when absent. */
  verifyCommands?: string[];
}

export interface ToolResult {
  ok: boolean;
  output: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  workspace: string;
  bypassActivation?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permissionLevel: number;
  /** Runtime infrastructure tool that remains visible and bypasses ordinary approval gates. */
  system?: boolean;
  /** Safety class used by loop batching and plan-mode tool injection. */
  kind?: ToolKind;
  /** On-demand tools are hidden from the initial tool list until activated via search_tools. */
  deferred?: boolean;

  maxOutputChars: number;
  invoke: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>;
}

export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
  passed: boolean;
}

export interface WorkspaceSnapshot {
  root: string;
  projectFiles: Record<string, string>;
  topLevel: string[];
  isGitRepo: boolean;
  gitBranch?: string;
  gitDirty?: boolean;
  scanTruncated?: boolean;
  recentFiles: string[];
  summary: string;
}

export interface RuntimeEventPayloads {
  state: { state: TaskState };
  log: { message: string };
  assistant_start: { step: number; source: string; attempt: number; model: string };
  assistant_delta: { step: number; source: string; attempt: number; text: string };
  thought_start: { step: number; source: string; attempt: number };
  thought_delta: { step: number; source: string; attempt: number; text: string };
  thought_end: { step: number; source: string; attempt: number; text: string; durationMs: number };
  assistant_end: {
    step: number;
    source: string;
    attempt: number;
    text: string;
    toolCalls: ToolCall[];
    usage: Record<string, number>;
    streamed: boolean;
    finishReason?: string;
  };
  assistant_abort: {
    step: number;
    source: string;
    attempt: number;
    message: string;
    finishReason?: string;
  };
  plan: { plan: string; streamed?: boolean; complete?: boolean };
  plan_complete: { plan: string; autoExecute: boolean; permissionMode?: PermissionMode; workMode?: WorkMode };
  task_plan_updated: { planState: TaskPlanState };
  approval_request: {
    requestId: string;
    call: ToolCall;
    level: number;
    description: string;
  };
  tool_start: { call: ToolCall; index: number; permissionLevel: number };
  tool_result: { call: ToolCall; index: number; result: ToolResult };
  verify: { results: VerificationResult[] };
  retry: { step: number; source: string; attempt: number; nextAttempt: number; maxRetries: number; message: string };
  context_compaction: {
    phase: "started" | "completed" | "failed" | "offloaded";
    reason: "auto" | "manual" | "emergency";
    beforeTokens?: number;
    afterTokens?: number;
    replacementCount?: number;
    message?: string;
  };
  error: { message: string; step?: number; source?: string; attempt?: number };
  completed: { steps: number; tokensUsed: number; inputTokens: number; outputTokens: number };
 cancelled: { message: string };
}

export type RuntimeEvent = {
  [K in keyof RuntimeEventPayloads]: {
    version: 1;
    type: K;
    taskId: string;
    turnId?: string;
    sequence: number;
    timestamp: string;
  } & RuntimeEventPayloads[K];
}[keyof RuntimeEventPayloads];

export type ApprovalResponse = boolean | "task" | "always";
export type ApprovalCallback = (
  call: ToolCall,
  level: number,
  description: string,
  requestId: string,
) => ApprovalResponse | Promise<ApprovalResponse>;

export interface AgentEvent {
  type: "state" | "assistant_start" | "assistant_delta" | "assistant_end" | "tool_start" | "tool_result" | "error" | "completed";
  state?: string;
  text?: string;
  toolCalls?: ToolCall[];
  streamed?: boolean;
  call?: ToolCall;
  permissionLevel?: number;
  result?: ToolResult;
  message?: string;
  steps?: number;
  tokensUsed?: number;
  planState?: TaskPlanState;
}

export interface AgentOptions {
  workspace: string;
  prompt: string;
  model: ModelConfig;
  maxSteps: number;
  approveAll: boolean;
  onEvent?: (event: AgentEvent) => void;
  approve?: (call: ToolCall, level: number) => Promise<boolean>;
  stablePromptModules?: OptionalSystemPromptModules;
}

export interface HookRule {
  id?: string;
  event: string;
  if?: string;
  action: {
    type: string;
    command?: string;
    prompt?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  };
  intercept?: boolean;
  once?: boolean;
  async?: boolean;
  onError?: "ignore" | "fail" | "reject";
}

export interface HookEnginePort {
  readonly hasRules: boolean;
  getErrors(): readonly { index: number; id?: string; message: string }[];
  dispatch(ctx: HookEventPortContext): Promise<unknown>;
  dispatchBeforeTool(ctx: HookEventPortContext): Promise<{ intercepted: boolean; interceptReason?: string }>;
  drainNotices(): { event: string; text: string }[];
  resetOnce(): void;
}

export interface HookEventPortContext {
  event: string;
  tool?: ToolCall;
  filePath?: string;
  userPrompt?: string;
  assistantText?: string;
  workspace?: string;
  model?: string;
}
