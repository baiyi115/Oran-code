import { randomUUID } from "node:crypto";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type WorkMode = "plan" | "auto";
export type PermissionMode = "readonly" | "default" | "accept-edits" | "plan" | "bypass";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ToolKind = "readonly" | "write" | "command";
export type SessionTitleMode = "first-message" | "local" | "model";

/** 模型请求失败的结构化分类,用于重试事件的诊断与展示。 */
export type ModelRetryCategory =
  | "rate_limit"
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "contract"
  | "empty"
  | "parse"
  | "unknown";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export const PERMISSION_MODES: readonly PermissionMode[] = ["readonly", "default", "accept-edits", "plan", "bypass"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 输出上限导致的截断标记(OpenAI 系 length、Anthropic max_tokens)。
 * 截断响应的文本与工具调用都可能不完整,调用方需按"整体判败"处理。
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
   * 上一轮模型输出的推理文本。请求体中默认不回传：OpenAI 兼容端点的
   * reasoning_content 只在端点明确要求时才带上（见 ModelConfig.reasoningEchoRequired）。
   */
  reasoning?: string;
  /** Anthropic 扩展思考的签名，与 reasoning 一起构成可回放的 thinking 块。 */
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
   * 输出被输出上限截断(finishReason 为 length/max_tokens)。
   * 截断响应的内容不完整:调用方不得当作最终答案,也不得执行其工具调用。
   */
  truncated?: boolean;
  /**
   * 因截断而**被丢弃**的工具调用数量(provider 解析层与 requester 兜底层的合计)。
   * 用来区分"纯文本被截断"(文本属于回答内容,可续写汇聚)与"工具调用被截断"
   * (文本多半只是前言,不应混进最终答案)。
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
  /** Anthropic thinking 块的签名：只用于回放，不产生任何 UI 事件。 */
  | { type: "reasoning_signature"; signature: string; streamed: boolean }
  | { type: "tool_call_complete"; toolCall: ToolCallComplete; streamed: boolean }
  | { type: "usage"; usage: Record<string, number>; streamed: boolean }
  | {
      type: "response_complete";
      streamed: boolean;
      finishReason?: string;
      /** 解析层在截断时丢弃的工具调用数量(见 ModelResponse.truncatedToolCalls)。 */
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
  /** 该端点拒绝 reasoning_effort 参数时置位，请求体不再携带。 */
  reasoningEffortDisabled?: boolean;
  /**
   * 该端点要求把历史 assistant 消息的 reasoning_content 原样回传时置位。
   * 只在进程内记忆（由 400 探测得来），不写入用户配置文件。
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
  skipVerify?: boolean;
  maxSteps?: number;
  /** Pause after this many consecutive turns without semantic progress. 0 disables this guard. */
  noProgressLimit?: number;
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
  web?: WebSettings;
}

/**
 * 联网工具(web_fetch / web_search)设置。
 * 搜索能力默认不开启:配置了 searchApiKey(或端点)才暴露 web_search。
 */
export interface WebSettings {
  /** 关闭后不注册任何联网工具。 */
  enabled?: boolean;
  /** 搜索后端协议,默认 tavily。 */
  searchProvider?: "tavily" | "searxng" | "brave" | "google";
  /** 搜索端点;searxng 必填,其余后端缺省用各自官方地址。 */
  searchEndpoint?: string;
  searchApiKey?: string;
  /** Google Programmable Search 的引擎 ID(cx),provider=google 时必填。 */
  searchEngineId?: string;
  /** 单次抓取交给模型的字符上限,默认 32000。 */
  fetchMaxChars?: number;
  /** 允许访问回环/内网地址,默认 false(SSRF 防护)。 */
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
   * 可选的输出后处理,在中央截断之前执行(先清洗再限量)。
   * 只用于确定性清洗(如 shell 的 ANSI/重复行);异常会被忽略并回退到原始输出。
   */
  postprocess?: ((output: string) => string) | undefined;
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
    /** 中止前已收到的部分用量,供调用方入账。 */
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
  verify: { results: VerificationResult[] };
  retry: {
    step: number;
    source: string;
    attempt: number;
    nextAttempt: number;
    maxRetries: number;
    message: string;
    /** 结构化失败分类,便于诊断与按类统计。 */
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
