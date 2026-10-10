import type {
  ApprovalResponse,
  Message,
  ModelReference,
  PermissionMode,
  ReasoningEffort,
  RuntimeEvent,
  TaskState,
  ToolCall,
  VerificationResult,
  WorkMode,
} from "../types.js";
import type { SlashCommand } from "../commands.js";
import type { SubagentOrigin } from "../subagent/types.js";

export interface TuiAppOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WriteStream;
  getWorkspace: () => string;
  getModelLabel: () => string;
  getSessionName?: () => string;
  getApprovalPolicy?: () => "ask" | "all";
  getFollowUpCount?: () => number;
  /** 后台子代理与 shell 作业的实时列表(异步数据源,允许 Promise)。 */
  getBackgroundTasks?: () => readonly TuiBackgroundTask[] | Promise<readonly TuiBackgroundTask[]>;
  /** 会话当前的上下文用量估算(tokens),用于 footer 的 ctx% 指示。 */
  getContextEstimate?: () => number | undefined;
  onInput: (value: string) => Promise<void>;
  onCancel: () => boolean;
  loadModels: () => Promise<string[]>;
  onModelSelected: (reference: string) => Promise<boolean | void>;
  loadRemoteModels?: (
    baseURL: string,
    apiKey: string,
    protocol: "openai" | "anthropic",
  ) => Promise<ConnectModelOption[]>;
  onConnect?: (input: ConnectInput) => Promise<boolean | void>;
  loadSessions?: () => Promise<SessionOption[]>;
  onSessionSelected?: (id: string) => Promise<SessionView | undefined>;
  onSessionCreated?: (name?: string) => Promise<SessionView | undefined>;
  onSessionDeleted?: (id: string) => Promise<SessionView | undefined>;
  loadProviders?: () => Promise<ProviderOption[]>;
  onProviderSelected?: (name: string) => Promise<boolean | void>;
  onProviderDeleted?: (name: string) => Promise<boolean>;
  loadFollowUps?: () => Promise<FollowUpOption[]> | FollowUpOption[];
  onFollowUpCancelled?: (id: string) => Promise<boolean> | boolean;
  loadFiles?: (query: string) => Promise<string[]>;
  onSessionChanged?: (view: SessionView) => void | Promise<void>;
  initialSession?: SessionView;
  getWorkMode?: () => WorkMode;
  onWorkModeChanged?: (mode: WorkMode) => boolean | Promise<boolean>;
  getPermissionMode?: () => PermissionMode;
  onPermissionModeChanged?: (mode: PermissionMode) => boolean | Promise<boolean>;
  getReasoningEffort?: () => ReasoningEffort;
  onReasoningEffortChanged?: (effort: ReasoningEffort) => boolean | Promise<boolean>;
  getContextWindow?: () => number | undefined;
  getModelReference?: () => ModelReference | undefined;
  getModelWarning?: () => string | undefined;
  isInteractionBlocked?: () => boolean;
  history?: readonly string[];
  getCommands?: () => readonly SlashCommand[];
  onRenderDebug?: (info: TuiRenderDebugInfo) => void;
}

export interface TuiRenderDebugInfo {
  phase: "committed" | "destroyed" | "render_wait_timeout";
  revision: number;
  committedRevision: number;
  staticCount: number;
}

export type TuiRenderCommitKind = "normal" | "boundary" | "terminal";

export type TuiOverlay =
  | "none"
  | "commands"
  | "models"
  | "sessions"
  | "session-delete-confirm"
  | "follow-ups"
  | "files"
  | "approval"
  | "details"
  | "connect"
  | "question";

export interface QuestionDialogOption {
  label: string;
  description: string;
  preview?: string | undefined;
}

export interface QuestionDialogItem {
  header: string;
  question: string;
  options: QuestionDialogOption[];
  multiSelect?: boolean | undefined;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface PasteBlock {
  text: string;
}

export interface ComposerDraft {
  text: string;
  cursor: CursorPosition;
  pastes: PasteBlock[];
}

export interface ComposerState {
  lines: string[];
  cursor: CursorPosition;
  preferredDisplayColumn: number | undefined;
  history: string[];
  historyIndex: number | undefined;
  historyDraft: string;
  /** Folded paste payloads referenced by [paste #N +M lines] placeholders. */
  pastes: PasteBlock[];
  /** 撤销/重做栈(整份草稿快照,按段合并;见 composer.ts 的 UNDO_COALESCE_MS)。 */
  undo: ComposerDraft[];
  redo: ComposerDraft[];
  /** 上次快照的时间与操作类型(同类型操作在时间阈值内合并为一段)。 */
  undoMarker?: { at: number; op: string } | undefined;
}

export interface TranscriptScrollState {
  offsetFromBottom: number;
  followBottom: boolean;
  anchor?: TranscriptScrollAnchor | undefined;
}

export interface TranscriptScrollAnchor {
  messageId: string;
  lineOffset: number;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TuiBackgroundTask {
  readonly id: string;
  readonly name: string;
  /** 后台来源:子代理(缺省)或 shell 作业。展示文案按此区分。 */
  readonly kind?: "subagent" | "job" | undefined;
  readonly origin?: SubagentOrigin | undefined;
  readonly definitionName?: string | undefined;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly error?: string | undefined;
  /** 任务输出(完成后的结果文本,供详情视图展示)。 */
  readonly output?: string | undefined;
}

export interface TuiSessionState {
  workspace: string;
  sessionId: string;
  sessionName: string;
  modelLabel: string;
  modelReference?: ModelReference;
  modelWarning?: string;
  workMode: WorkMode;
  permissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort;
  contextWindow?: number;
  /** 当前会话上下文的估算 token 数(估出 ctx% 用)。 */
  contextEstimate?: number | undefined;
  approvalPolicy: "ask" | "all";
  taskState: TaskState | "ready";
  status: string;
  currentStep: number | undefined;
  currentTool: string | undefined;
  startedAt: number | undefined;
  elapsedMs: number | undefined;
  modelElapsedMs: number | undefined;
  outputTokensPerSecond: number | undefined;
  usage: UsageState;
  followUpCount: number;
  backgroundTasks: readonly TuiBackgroundTask[];
}

export interface UserMessage {
  id: string;
  kind: "user";
  text: string;
  queued?: boolean;
}

export interface AssistantMessage {
  id: string;
  kind: "assistant";
  text: string;
  streaming?: boolean;
  turnId?: string;
  taskId?: string;
  abortMessage?: string;
}

export interface ThoughtMessage {
  id: string;
  kind: "thought";
  text: string;
  durationMs?: number;
  streaming?: boolean;
  expanded: boolean;
  turnId?: string;
  taskId?: string;
}

export interface ToolMessage {
  id: string;
  kind: "tool";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  permissionLevel: number;
  status: "running" | "success" | "failure" | "rejected" | "cancelled";
  startedAt?: string;
  durationMs?: number;
  summary?: string;
  output?: string;
  error?: string;
  expanded: boolean;
  /** Latest progress note while the tool runs; cleared once it produces a result. */
  progress?: string;
  /** 由结果 metadata 派生的语义徽标(cached/denied/hook/repaired/unavailable)。 */
  badges?: string[];
  taskId?: string;
}

export interface VerificationMessage {
  id: string;
  kind: "verification";
  results: VerificationResult[];
}

export type TranscriptMessage =
  | UserMessage
  | AssistantMessage
  | ThoughtMessage
  | ToolMessage
  | VerificationMessage
  | { id: string; kind: "system" | "plan" | "error"; text: string };

export type TranscriptMessageInput =
  | Omit<UserMessage, "id">
  | Omit<AssistantMessage, "id">
  | Omit<ThoughtMessage, "id">
  | Omit<ToolMessage, "id">
  | Omit<VerificationMessage, "id">
  | { kind: "system" | "plan" | "error"; text: string };

export interface ApprovalDetails {
  call: ToolCall;
  level: number;
  description: string;
  workspace: string;
  origin: SubagentOrigin;
}

export type OverlayState =
  | { kind: "none" }
  | { kind: "commands"; query: string; selectedIndex: number }
  | {
      kind: "models";
      query: string;
      selectedIndex: number;
      options: string[];
      loading: boolean;
      error?: string | undefined;
    }
  | { kind: "sessions"; query: string; selectedIndex: number; options: SessionOption[] }
  | {
      kind: "session-delete-confirm";
      sessionId: string;
      sessionName: string;
      selectedIndex: number;
      returnSelectedIndex: number;
      options: SessionOption[];
    }
  | { kind: "follow-ups"; selectedIndex: number; options: FollowUpOption[] }
  | {
      kind: "files";
      query: string;
      selectedIndex: number;
      options: string[];
      loading: boolean;
      tokenStart: number;
      /** 触发时是 @fragment 还是 @" ...(带空格路径),决定补全是否带引号。 */
      quoted: boolean;
    }
  | { kind: "approval"; approval: ApprovalDetails; selectedIndex: number }
  | {
      kind: "details";
      title: string;
      lines: string[];
      /** 从底部算起的滚动距离:0 = 贴近内容开头,>0 = 向上滚动。 */
      scrollOffset?: number;
    }
  | {
      kind: "connect";
      step: ConnectStep;
      activeField: ConnectInfoField;
      providerName: string;
      baseURL: string;
      apiKey: string;
      protocol: "openai" | "anthropic" | "";
      /** 用户手动改过 name/protocol 后,不再随 baseURL 自动推导。 */
      nameTouched: boolean;
      protocolTouched: boolean;
      models: ConnectModelOption[];
      selectedIndex: number;
      loading: boolean;
      error?: string | undefined;
    }
  | { kind: "providers"; selectedIndex: number; options: ProviderOption[] }
  | {
      kind: "provider-delete-confirm";
      providerName: string;
      selectedIndex: number;
      returnSelectedIndex: number;
      options: ProviderOption[];
    }
  | {
      kind: "question";
      questions: QuestionDialogItem[];
      currentQuestionIndex: number;
      selectedIndex: number;
      selectedIndices: number[];
      answers: Record<string, string>;
    };

export type ConnectStep = "info" | "models";

export type ConnectInfoField = "baseURL" | "apiKey" | "protocol" | "name";

export interface ConnectModelOption {
  id: string;
  contextWindow?: number;
  /** 向导内用 E 手动指定的思考等级;缺省走默认 high(端点拒绝时运行时回退)。 */
  reasoningEffort?: ReasoningEffort;
  selected: boolean;
}

export interface ConnectInput {
  providerName: string;
  baseURL: string;
  apiKey: string;
  protocol: "openai" | "anthropic";
  /** 向导不再统一询问,未指定时按 high 写入并在运行时按需回退。 */
  reasoningEffort?: ReasoningEffort;
  models: ConnectModelOption[];
}

/** `/connect <provider>` 预填编辑时携带的已有配置。 */
export interface ConnectPrefill {
  providerName: string;
  baseURL: string;
  apiKey: string;
  protocol: "openai" | "anthropic";
  models: { id: string; reasoningEffort?: ReasoningEffort }[];
}

export interface ProviderOption {
  name: string;
  baseURL: string;
  protocol: "openai" | "anthropic";
  modelCount: number;
  isCurrent: boolean;
}

export interface SessionOption {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
  isCurrent: boolean;
}

export interface FollowUpOption {
  id: string;
  prompt: string;
  createdAt: string;
}

export interface SessionView {
  id: string;
  name: string;
  messages: TranscriptMessage[];
  history: string[];
  workMode?: WorkMode;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort;
  modelReference?: ModelReference | undefined;
  modelWarning?: string | undefined;
  conversation?: Message[];
}

export interface TuiState {
  commands: SlashCommand[];
  session: TuiSessionState;
  composer: ComposerState;
  overlay: OverlayState;
  transcript: TranscriptMessage[];
  /** Tool-group ids explicitly expanded for the current TUI session. */
  expandedToolGroupIds: Set<string>;
  streaming: boolean;
  assistantMessageId: string | undefined;
  thoughtMessageId: string | undefined;
  /** True between assistant_start and the first chunk (thought/assistant/tool) — fills the pre-first-chunk gap with a waiting indicator. */
  waitingForFirstChunk: boolean;
  nextMessageId: number;
  lastSequence: number;
  activeTaskId: string | undefined;
  activeTaskUsage: UsageState;
  processedSequences: Set<string>;
  retiredTaskIds: Set<string>;
  /** Transient retry-failure notice, cleared once a fresh response streams. */
  retryErrorId: string | undefined;
  transcriptScroll: TranscriptScrollState;
  lastTranscriptLines: number;
  lastTranscriptViewportLines: number;
  /**
   * details 覆盖层实际可滚到的最大偏移,由渲染侧按同一套窗口公式写入。
   * 键盘处理读它而不是自己算:两侧算法不一致时,滚到底会有一长段"空按"。
   */
  detailsScrollMax: number;
}

export interface TuiEventSink {
  render(event: RuntimeEvent): void;
  user(prompt: string, queued?: boolean): void;
  status(message: string, style?: string): void;
  markdown(title: string, content: string): void;
  error(message: string): void;
  clearTranscript(): void;
  approval(
    call: ToolCall,
    level: number,
    description: string,
    origin: SubagentOrigin,
  ): Promise<ApprovalResponse> | void;
}
