import type { ApprovalDetails, ComposerState, OverlayState, TranscriptMessage, TranscriptMessageInput, TuiSessionState, TuiState } from "./types.js";
import type { PermissionMode, ReasoningEffort, WorkMode } from "../types.js";
import { graphemeLength } from "./text-width.js";
import { DEFAULT_COMMAND_REGISTRY } from "../commands.js";

export function createComposerState(history: readonly string[] = []): ComposerState {
  return {
    lines: [""],
    cursor: { line: 0, column: 0 },
    preferredDisplayColumn: undefined,
    history: [...history],
    historyIndex: undefined,
    historyDraft: "",
    pastes: [],
  };
}

export function createTuiSessionState(
  workspace: string,
  modelLabel: string,
  sessionId = "session-current",
  sessionName = "Current session",
  workMode: WorkMode = "auto",
  permissionMode: PermissionMode = workMode === "plan" ? "plan" : "default",
  reasoningEffort: ReasoningEffort = "medium",
  contextWindow?: number,
  modelReference?: TuiSessionState["modelReference"],
  modelWarning?: string,
): TuiSessionState {
  return {
    workspace,
    sessionId,
    sessionName,
    modelLabel,
    ...(modelReference ? { modelReference } : {}),
    ...(modelWarning ? { modelWarning } : {}),
    workMode,
    permissionMode,
    reasoningEffort,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    approvalPolicy: "ask",
    taskState: "ready",
    status: "",
    currentStep: undefined,
    currentTool: undefined,
    startedAt: undefined,
    elapsedMs: undefined,
    modelElapsedMs: undefined,
    outputTokensPerSecond: undefined,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    followUpCount: 0,
  };
}

export function createTuiState(
  workspace: string,
  modelLabel: string,
  history: readonly string[] = [],
  workMode: WorkMode = "auto",
  permissionMode: PermissionMode = workMode === "plan" ? "plan" : "default",
  reasoningEffort: ReasoningEffort = "medium",
  contextWindow?: number,
  sessionId = "session-current",
  sessionName = "Current session",
  initialTranscript: readonly TranscriptMessage[] = [],
  modelReference?: TuiSessionState["modelReference"],
  modelWarning?: string,
): TuiState {
  return {
    commands: DEFAULT_COMMAND_REGISTRY.list(),
    session: createTuiSessionState(workspace, modelLabel, sessionId, sessionName, workMode, permissionMode, reasoningEffort, contextWindow, modelReference, modelWarning),
    composer: createComposerState(history),
   overlay: { kind: "none" },
   transcript: [...initialTranscript],
   expandedToolGroupIds: new Set(),
    streaming: false,
    assistantMessageId: undefined,
    thoughtMessageId: undefined,
    waitingForFirstChunk: false,
    nextMessageId: nextMessageNumber(initialTranscript),
    lastSequence: 0,
    activeTaskId: undefined,
    activeTaskUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    processedSequences: new Set<string>(),
    retiredTaskIds: new Set<string>(),
    retryErrorId: undefined,
    transcriptScroll: { offsetFromBottom: 0, followBottom: true },
    lastTranscriptLines: 0,
    lastTranscriptViewportLines: 0,
  };
}

export function composerValue(composer: ComposerState): string {
  return composer.lines.join("\n");
}

export function setComposerValue(composer: ComposerState, value: string): void {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  composer.lines = lines.length ? lines : [""];
  const lastLine = composer.lines.length - 1;
  composer.cursor = { line: lastLine, column: graphemeLength(composer.lines[lastLine] ?? "") };
  composer.preferredDisplayColumn = undefined;
}

export function appendTranscriptMessage(
  state: TuiState,
  message: TranscriptMessageInput,
): string {
  const id = `message-${state.nextMessageId++}`;
  state.transcript.push({ id, ...message });
  return id;
}

export function getToolMessage(state: TuiState, callId: string, taskId?: string): Extract<TranscriptMessage, { kind: "tool" }> | undefined {
  if (taskId !== undefined) {
    const exact = state.transcript.find((entry) => entry.kind === "tool" && entry.callId === callId && entry.taskId === taskId);
    if (exact?.kind === "tool") return exact;
  }
  const legacy = state.transcript.filter((entry) => entry.kind === "tool" && entry.callId === callId && entry.taskId === undefined);
  return legacy.length === 1 && legacy[0]?.kind === "tool" ? legacy[0] : undefined;
}

function nextMessageNumber(transcript: readonly TranscriptMessage[]): number {
  let maximum = 0;
  for (const message of transcript) {
    const match = /^message-(\d+)$/.exec(message.id);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

export function setOverlay(state: TuiState, overlay: OverlayState): void {
  state.overlay = overlay;
}

export function clearOverlay(state: TuiState): void {
  state.overlay = { kind: "none" };
}

export function setApproval(state: TuiState, approval: ApprovalDetails): void {
  state.overlay = { kind: "approval", approval, selectedIndex: 0 };
  state.session.status = "approval required";
}
