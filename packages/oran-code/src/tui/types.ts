import type { ApprovalResponse, Message, ModelReference, PermissionMode, ReasoningEffort, RuntimeEvent, TaskState, ToolCall, VerificationResult, WorkMode } from "../types.js";
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
  onInput: (value: string) => Promise<void>;
  onCancel: () => boolean;
  loadModels: () => Promise<string[]>;
  onModelSelected: (reference: string) => Promise<boolean | void>;
  loadSessions?: () => Promise<SessionOption[]>;
  onSessionSelected?: (id: string) => Promise<SessionView | undefined>;
  onSessionCreated?: (name?: string) => Promise<SessionView | undefined>;
  onSessionDeleted?: (id: string) => Promise<SessionView | undefined>;
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
}

export type TuiOverlay = "none" | "commands" | "models" | "sessions" | "session-delete-confirm" | "follow-ups" | "files" | "approval";

export interface CursorPosition {
  line: number;
  column: number;
}

export interface ComposerState {
  lines: string[];
  cursor: CursorPosition;
  preferredDisplayColumn: number | undefined;
  history: string[];
  historyIndex: number | undefined;
  historyDraft: string;
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
  approvalPolicy: "ask" | "all";
  taskState: TaskState | "ready";
  status: string;
  currentStep: number | undefined;
  currentTool: string | undefined;
  startedAt: number | undefined;
  elapsedMs: number | undefined;
  usage: UsageState;
  followUpCount: number;
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
  | { kind: "models"; query: string; selectedIndex: number; options: string[]; loading: boolean; error?: string | undefined }
  | { kind: "sessions"; query: string; selectedIndex: number; options: SessionOption[] }
  | { kind: "session-delete-confirm"; sessionId: string; sessionName: string; selectedIndex: number; returnSelectedIndex: number; options: SessionOption[] }
  | { kind: "follow-ups"; selectedIndex: number; options: FollowUpOption[] }
  | { kind: "files"; query: string; selectedIndex: number; options: string[]; loading: boolean; tokenStart: number }
  | { kind: "approval"; approval: ApprovalDetails; selectedIndex: number };

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
  streaming: boolean;
  assistantMessageId: string | undefined;
  thoughtMessageId: string | undefined;
  nextMessageId: number;
  lastSequence: number;
  activeTaskId: string | undefined;
  activeTaskUsage: UsageState;
  processedSequences: Set<string>;
  retiredTaskIds: Set<string>;
  transcriptScroll: TranscriptScrollState;
  lastTranscriptLines: number;
  lastTranscriptViewportLines: number;
}

export interface TuiEventSink {
  render(event: RuntimeEvent): void;
  user(prompt: string, queued?: boolean): void;
  status(message: string, style?: string): void;
  markdown(title: string, content: string): void;
  error(message: string): void;
  clearTranscript(): void;
  approval(call: ToolCall, level: number, description: string, origin: SubagentOrigin): Promise<ApprovalResponse> | void;
}
