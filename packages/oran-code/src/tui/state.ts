import type {
  ComposerState,
  OverlayState,
  TranscriptMessage,
  TranscriptMessageInput,
  TuiSessionState,
  TuiState,
} from "./types.js";
import type { PermissionMode, ReasoningEffort, WorkMode } from "../types.js";
import { graphemeLength } from "./text-width.js";
import { pushUndoSnapshot } from "./composer.js";
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
    undo: [],
    redo: [],
  };
}

function createTuiSessionState(
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
    taskState: "ready",
    status: "",
    currentTool: undefined,
    startedAt: undefined,
    elapsedMs: undefined,
    outputTokensPerSecond: undefined,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    subagentUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    followUpCount: 0,
    backgroundTasks: [],
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
    session: createTuiSessionState(
      workspace,
      modelLabel,
      sessionId,
      sessionName,
      workMode,
      permissionMode,
      reasoningEffort,
      contextWindow,
      modelReference,
      modelWarning,
    ),
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
    detailsScrollMax: 0,
    cancelArmedUntil: undefined,
  };
}

/**
 * A session persisted mid-turn keeps `streaming: true` / `status: "running"` on the message it was
 * writing, but no runtime is attached to a restored transcript to ever clear them. Left as they
 * are, the spinner spins forever, the footer hides every status, and the Static boundary freezes at
 * the first live row — so the tail of the transcript is unreadable for the rest of the session.
 */
export function normalizeRestoredTranscript(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.map((message) => {
    if (message.kind === "assistant" && message.streaming) return { ...message, streaming: false };
    if (message.kind === "thought" && message.streaming) return { ...message, streaming: false };
    if (message.kind === "tool" && message.status === "running") return { ...message, status: "cancelled" };
    return message;
  });
}

export function composerValue(composer: ComposerState): string {
  return composer.lines.join("\n");
}

export function setComposerValue(composer: ComposerState, value: string, recordUndo = true): void {
  if (recordUndo) pushUndoSnapshot(composer, "set");
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  composer.lines = lines.length ? lines : [""];
  const lastLine = composer.lines.length - 1;
  composer.cursor = { line: lastLine, column: graphemeLength(composer.lines[lastLine] ?? "") };
  composer.preferredDisplayColumn = undefined;
}

export function appendTranscriptMessage(state: TuiState, message: TranscriptMessageInput): string {
  const id = `message-${state.nextMessageId++}`;
  state.transcript.push({ id, ...message });
  return id;
}

export function getToolMessage(
  state: TuiState,
  callId: string,
  taskId?: string,
): Extract<TranscriptMessage, { kind: "tool" }> | undefined {
  // One pass: this runs on every tool event, and the old shape walked the transcript twice.
  let legacy: Extract<TranscriptMessage, { kind: "tool" }> | undefined;
  let legacyCount = 0;
  for (const entry of state.transcript) {
    if (entry.kind !== "tool" || entry.callId !== callId) continue;
    if (taskId !== undefined && entry.taskId === taskId) return entry;
    if (entry.taskId === undefined) {
      legacy = entry;
      legacyCount += 1;
    }
  }
  // A call id without a task still matches when it is unambiguous.
  return legacyCount === 1 ? legacy : undefined;
}

export function nextMessageNumber(transcript: readonly TranscriptMessage[]): number {
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
