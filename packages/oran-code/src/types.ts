import { randomUUID } from "node:crypto";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type WorkMode = "plan" | "auto";
export type PermissionMode = "readonly" | "default" | "accept-edits" | "plan" | "bypass";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ToolKind = "readonly" | "write" | "command";
export type SessionTitleMode = "first-message" | "local" | "model";

/** Structured classification of model request failures, for diagnosing and displaying retry events. */
export type ModelRetryCategory =
  "rate_limit" | "timeout" | "network" | "http_4xx" | "http_5xx" | "contract" | "empty" | "parse" | "unknown";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export const PERMISSION_MODES: readonly PermissionMode[] = ["readonly", "default", "accept-edits", "plan", "bypass"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Truncation markers caused by an output limit (OpenAI-style length, Anthropic max_tokens).
 * Both the text and the tool calls of a truncated response may be incomplete, so callers
 * must treat it as an outright failure.
 */
export function isTruncatedFinishReason(value: string | undefined): boolean {
  return value === "length" || value === "max_tokens";
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

/** A provider-normalized tool call whose JSON arguments are complete but unparsed. */
export interface ToolCallComplete {
  index: number;
  id?: string;
  name: string;
  argumentsJson: string;
}

export interface Message {
  role: MessageRole;
  content?: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Reasoning text from the previous model output. It is not sent back in the request body
   * by default: an OpenAI-compatible endpoint's reasoning_content is only included when the
   * endpoint explicitly asks for it (see ModelConfig.reasoningEchoRequired).
   */
  reasoning?: string;
  /** Signature of an Anthropic extended-thinking block; with reasoning it forms a replayable
   * thinking block. */
  reasoningSignature?: string;
}

export interface ModelResponse {
  text: string;
  reasoning?: string;
  reasoningSignature?: string;
  toolCalls: ToolCall[];
  raw: Record<string, unknown>;
  usage: Record<string, number>;
  finishReason?: string;
  streamed: boolean;
  /**
   * The output was cut off by the output limit (finishReason is length/max_tokens).
   * A truncated response is incomplete: callers must not treat it as a final answer nor
   * execute its tool calls.
   */
  truncated?: boolean;
  /**
   * Number of tool calls **discarded** because of truncation (provider parsing layer and
   * requester fallback layer combined). It separates "plain text was truncated" (the text
   * is part of the answer and can be continued and merged) from "tool calls were truncated"
   * (the text is mostly just a preamble and must not mix into the final answer).
   */
  truncatedToolCalls?: number;
}

/**
 * Provider-independent events emitted while a model response is produced.
 *
 * Tool arguments stay raw until a provider signals that a call is complete.
 * This prevents partially streamed JSON from reaching the execution layer.
 */
export type ModelStreamChunk =
  | { type: "text_delta"; text: string; streamed: boolean }
  | { type: "reasoning_delta"; text: string; streamed: boolean }
  /** Signature of an Anthropic thinking block: used for replay only, it emits no UI events. */
  | { type: "reasoning_signature"; signature: string; streamed: boolean }
  | { type: "tool_call_complete"; toolCall: ToolCallComplete; streamed: boolean }
  | { type: "usage"; usage: Record<string, number>; streamed: boolean }
  | {
      type: "response_complete";
      streamed: boolean;
      finishReason?: string;
      /** Number of tool calls the parsing layer dropped on truncation (see
       * ModelResponse.truncatedToolCalls). */
      droppedToolCalls?: number;
    };

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  /** Maximum time to wait for the next SSE chunk before treating the stream as stalled. */
  idleTimeoutMs?: number;
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
  /** Set when the endpoint rejects the reasoning_effort parameter; the body then omits it. */
  reasoningEffortDisabled?: boolean;
  /**
   * Set when the endpoint requires the reasoning_content of historical assistant messages
   * to be echoed back verbatim. Remembered in-process only (learned from a 400 probe); it is
   * not written to the user config file.
   */
  reasoningEchoRequired?: boolean;
  options?: Record<string, unknown>;
}

export interface ModelOptions {
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  disableReasoningEffort?: boolean;
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
  maxSteps?: number;
  /** Pause after this many consecutive turns without semantic progress. 0 disables this guard. */
  noProgressLimit?: number;
  tokenBudget?: number;
  workMode?: WorkMode;
  permissionMode?: PermissionMode;
  lastModel?: string;
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
  web?: WebSettings;
  /**
   * Allow this workspace's own config and hook files to set things that raise
   * permissions or run commands (approveAll, permissionMode, noProgressLimit,
   * mcpServers, hooks, web.allowPrivateHosts). Off by default, and only this
   * user-level file can turn it on: a workspace cannot opt itself in. Point the
   * agent at a repository you control before enabling it.
   */
  trustWorkspace?: boolean;
}

/**
 * Settings for the web tools (web_fetch / web_search).
 * Search is off by default: web_search is only exposed once searchApiKey (or an endpoint)
 * has been configured.
 */
export interface WebSettings {
  /**
   * Disabled web tools stay in the tool list and refuse when called, saying why:
   * registration does not read the settings, `invoke` does.
   */
  enabled?: boolean;
  /** Search backend protocol, tavily by default. */
  searchProvider?: "tavily" | "searxng" | "brave" | "google";
  /** Search endpoint; required for searxng, the other backends default to their official URL. */
  searchEndpoint?: string;
  searchApiKey?: string;
  /** Engine ID (cx) for Google Programmable Search; required when provider=google. */
  searchEngineId?: string;
  /** Character cap for a single fetch handed to the model, 32000 by default. */
  fetchMaxChars?: number;
  /** Allow access to loopback/private addresses, false by default (SSRF protection). */
  allowPrivateHosts?: boolean;
}

export interface LoopConfig {
  maxSteps: number;
  maxRetries: number;
  commandTimeout: number;
  /** Pause after this many consecutive turns without semantic progress. 0 disables this guard. */
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
  approveAll: boolean;
  traceDb?: string;
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
  signal?: AbortSignal | undefined;
  workspace: string;
  bypassActivation?: boolean | undefined;
  askUser?:
    | ((
        questions: Array<{
          header: string;
          question: string;
          options: Array<{ label: string; description: string; preview?: string | undefined }>;
          multiSelect?: boolean | undefined;
        }>,
      ) => Promise<Record<string, string>>)
    | undefined;
  /**
   * Report coarse progress from a tool that can run for a while. Calls are
   * advisory and may be dropped; a tool must not depend on them being delivered.
   */
  onProgress?: ((note: string) => void) | undefined;
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
  /** Set false for readonly tools whose result reflects live external state. */
  cacheable?: boolean;
  /** On-demand tools are hidden from the initial tool list until activated via search_tools. */
  deferred?: boolean;

  maxOutputChars: number;
  /**
   * Optional output post-processing, run before the central truncation (clean first, then
   * cap). Meant for deterministic cleanup only (such as the shell's ANSI codes/duplicate
   * lines); an exception is ignored and the original output is used instead.
   */
  postprocess?: ((output: string) => string) | undefined;
  invoke: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>;
}

/**
 * Read-compatibility only: the verification loop that produced these was removed (the
 * `verify` runtime event has no emitter), but sessions written while it existed still
 * carry the transcript entries, and the loader validates what it reads.
 */
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
    /** Partial usage already received before the abort, for the caller to record. */
    usage?: Record<string, number>;
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
  /**
   * Coarse progress from a tool that can run for a while (building the code
   * graph, for instance). It is advisory only: it never changes the result and
   * consumers may ignore it.
   */
  tool_progress: { call: ToolCall; note: string };
  retry: {
    step: number;
    source: string;
    attempt: number;
    nextAttempt: number;
    maxRetries: number;
    message: string;
    /** Structured failure category, for diagnosis and per-category counting. */
    category?: ModelRetryCategory;
  };
  context_compaction: {
    phase: "started" | "completed" | "failed" | "offloaded";
    reason: "auto" | "manual" | "emergency";
    beforeTokens?: number;
    afterTokens?: number;
    replacementCount?: number;
    message?: string;
  };
  error: { message: string; step?: number; source?: string; attempt?: number };
  completed: {
    steps: number;
    tokensUsed: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    elapsedMs: number;
    modelElapsedMs: number;
    outputTokensPerSecond?: number;
  };
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
  type:
    | "state"
    | "assistant_start"
    | "assistant_delta"
    | "assistant_end"
    | "tool_start"
    | "tool_result"
    | "error"
    | "completed";
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
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  elapsedMs?: number;
  modelElapsedMs?: number;
  outputTokensPerSecond?: number;
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
