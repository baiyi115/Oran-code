import React, { useEffect, useState } from "react";
import { Box, Static, Text, render, useInput, useStdout, type Key } from "ink";
import type { ApprovalResponse, ToolCall } from "../types.js";
import { REASONING_EFFORTS, type WorkMode } from "../types.js";
import { formatErrorMessage } from "../error-format.js";
import { commandCandidates } from "./command-palette.js";
import { navigateHistory } from "./interaction.js";
import { TuiTranscriptRenderer } from "./renderer.js";
import { composerValue, createTuiState, setComposerValue, setOverlay } from "./state.js";
import type {
  ComposerState,
  PasteBlock,
  SessionView,
  TuiAppOptions,
  TuiRenderCommitKind,
  TuiState,
  TranscriptMessage,
} from "./types.js";
import type { ConnectInput, ConnectPrefill } from "./types.js";
import { appendSystemMessage } from "./message-reducer.js";
import { nextMessageNumber } from "./state.js";
import {
  composerCursorOffset,
  cursorVisualPosition,
  deleteBackward,
  deleteForward,
  insertText,
  moveCursor,
  moveToLineEdge,
  visualLines,
} from "./composer.js";
import { TranscriptView, collapsibleSegments } from "./transcript/transcript-view.js";
import { footerLines, workSummaryLine } from "./footer.js";
import type { SubagentOrigin } from "../subagent/types.js";
import { commandPaletteLines } from "./command-palette.js";
import { COLORS, horizontalRule } from "./theme.js";
import { scrollPercent, scrollTranscript, syncTranscriptScroll } from "./scroll-controller.js";
import { hasActiveBackgroundTasks, isSessionBusy, workingIndicatorLine } from "./status-indicator.js";
import { isDeleteBackward, isDeleteForward, isEndKey, isHomeKey, isSubmitKey } from "./keys.js";
import { ConnectWizard } from "./connect-wizard.js";
import { OverlayHandlers } from "./overlay-handlers.js";
import {
  HighlightedLine,
  composerPrefix,
  fileQuery,
  fitOverlayLines,
  ghostCommandSuggestion,
  oranWelcomeLines,
  renderComposerLines,
  renderOverlayLines,
} from "./render.js";

interface InkTuiAppDependencies {
  render?: typeof render;
}

interface StaticTranscriptItem {
  id: string;
  text: string;
}

/** Only in-progress transcript entries need Ink's height-bounded live frame. */
export function staticTranscriptCount(messages: readonly TranscriptMessage[]): number {
  const firstMutableIndex = messages.findIndex(
    (message) =>
      (message.kind === "assistant" && message.streaming) ||
      (message.kind === "thought" && message.streaming) ||
      (message.kind === "tool" && message.status === "running"),
  );
  return firstMutableIndex >= 0 ? firstMutableIndex : messages.length;
}

// Mouse reporting prevents the terminal emulator from starting its native text
// selection. Clear every common tracking mode in case a previous process exited
// before restoring the terminal.
const RESTORE_NATIVE_MOUSE = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1015l\x1b[?1006l\x1b[?1005l";
// Ink 5 throttles its real stdout paint by 32ms but does not expose
// waitUntilRenderFlush(). Boundary events wait past that window so a short,
// burst-delivered response cannot skip directly to its completed frame.
const INK_PAINT_BARRIER_MS = 40;
/** boundary/terminal 事件等待渲染提交的上限;超时兜底放行并补一次渲染。 */
const RENDER_WAIT_TIMEOUT_MS = 1_000;

/**
 * Ink-backed TUI.
 *
 * Completed transcript messages are appended through Ink Static so the host
 * terminal owns scrollback, selection, and copying. Only the mutable tail and
 * composer chrome remain in Ink's dynamic frame.
 */
export class InkTuiApp {
  readonly renderer: TuiTranscriptRenderer;
  private readonly options: TuiAppOptions;
  private readonly connectWizard: ConnectWizard;
  private readonly overlayHandlers: OverlayHandlers;
  private readonly state: TuiState;
  private readonly transcript = new TranscriptView();
  private readonly renderInk: typeof render;
  private inkInstance: ReturnType<typeof render> | undefined;
  private resolveRun: (() => void) | undefined;
  private approvalResolve: ((response: ApprovalResponse) => void) | undefined;
  private destroyed = false;
  private dismissedCommandInput: string | undefined;
  private lastCancelAt = 0;
  /** True while the real caret is parked on the composer via DECSC/DECRC. */
  private parkedComposerCursor = false;
  private lastEscapeCancelAt = 0;
  private submitBusy = false;
  private renderScheduled = false;
  private renderRevision = 0;
  private committedRenderRevision = 0;
  private staticTranscriptGeneration = 0;
  /** Preserve append-only Static items by message ID within one generation. */
  private committedStaticTranscriptItems: StaticTranscriptItem[] = [];
  private readonly committedStaticTranscriptIds = new Set<string>();
  private readonly renderWaiters: Array<{ revision: number; resolve: () => void }> = [];
  private lastTranscriptRenderLines: ReturnType<TranscriptView["linesWithAnchors"]> = [];

  constructor(options: TuiAppOptions, dependencies: InkTuiAppDependencies = {}) {
    this.options = options;
    this.renderInk = dependencies.render ?? render;
    this.state = createTuiState(
      options.getWorkspace(),
      options.getModelLabel(),
      options.initialSession?.history ?? options.history,
      options.initialSession?.workMode ?? options.getWorkMode?.() ?? "auto",
      options.initialSession?.permissionMode ?? options.getPermissionMode?.() ?? "default",
      options.initialSession?.reasoningEffort ?? options.getReasoningEffort?.() ?? "medium",
      options.getContextWindow?.(),
      options.initialSession?.id,
      options.initialSession?.name,
      options.initialSession?.messages,
      options.initialSession?.modelReference ?? options.getModelReference?.(),
      options.initialSession?.modelWarning ?? options.getModelWarning?.(),
    );
    this.state.session.approvalPolicy = options.getApprovalPolicy?.() ?? "ask";
    this.state.session.backgroundTasks = options.getBackgroundTasks?.() ?? [];
    this.overlayHandlers = new OverlayHandlers({
      state: this.state,
      loadModels: () => options.loadModels(),
      ...(options.loadSessions ? { loadSessions: () => options.loadSessions!() } : {}),
      ...(options.onSessionSelected ? { onSessionSelected: (id: string) => options.onSessionSelected!(id) } : {}),
      ...(options.onSessionDeleted ? { onSessionDeleted: (id: string) => options.onSessionDeleted!(id) } : {}),
      ...(options.loadProviders ? { loadProviders: () => options.loadProviders!() } : {}),
      ...(options.onProviderSelected
        ? { onProviderSelected: (name: string) => options.onProviderSelected!(name) }
        : {}),
      ...(options.onProviderDeleted ? { onProviderDeleted: (name: string) => options.onProviderDeleted!(name) } : {}),
      openConnect: () => this.connectWizard.open(),
      onModelSelected: (reference) => options.onModelSelected(reference),
      ...(options.loadFollowUps ? { loadFollowUps: () => options.loadFollowUps!() } : {}),
      ...(options.onFollowUpCancelled ? { onFollowUpCancelled: (id: string) => options.onFollowUpCancelled!(id) } : {}),
      invalidate: () => this.invalidate(),
      rejectIfBlocked: (message) => this.rejectIfBlocked(message),
      refreshContext: () => this.refreshContext(),
      restoreSessionView: (session, notice) => this.restoreSessionView(session, notice),
      restoreSession: (session) => this.restoreSession(session),
      submit: (forcedCommand) => this.submit(forcedCommand),
      handleComposerKey: (input, key) => this.handleComposerKey(input, key),
      detachInputHistory: () => this.detachInputHistory(),
      noteDismissedCommandInput: (value) => {
        this.dismissedCommandInput = value;
      },
      resolveApproval: (response) => this.resolveApproval(response),
    });
    this.connectWizard = new ConnectWizard({
      state: this.state,
      ...(options.loadRemoteModels
        ? {
            loadRemoteModels: (baseURL: string, apiKey: string, protocol: "openai" | "anthropic") =>
              options.loadRemoteModels!(baseURL, apiKey, protocol),
          }
        : {}),
      ...(options.onConnect ? { onConnect: (input: ConnectInput) => options.onConnect!(input) } : {}),
      invalidate: () => this.invalidate(),
      rejectIfBlocked: (message) => this.rejectIfBlocked(message),
    });
    this.state.commands = [...(options.getCommands?.() ?? this.state.commands)];
    if (options.initialSession?.modelWarning) {
      appendSystemMessage(this.state, options.initialSession.modelWarning, "error");
    }
    const layout = {
      redraw: (_state: TuiState) => this.invalidate(),
      resetStatic: () => this.resetStaticTranscript(),
    };
    this.renderer = new TuiTranscriptRenderer(layout, this.state);
    this.renderer.setApprovalHandler((call, level, description, origin) =>
      this.openApproval(call, level, description, origin),
    );
    this.renderer.setApprovalCancelHandler(() => this.cancelApproval());
  }

  run(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.restoreNativeMouse();
    this.inkInstance = this.renderInk(<InkRoot app={this} revision={this.renderRevision} />, {
      stdin: this.options.input as NodeJS.ReadStream,
      stdout: this.options.output,
      exitOnCtrlC: false,
    });
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve;
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelApproval();
    if (this.state.session.status === "press Ctrl+C again to exit") {
      this.state.session.status = "";
    }
    this.unparkComposerCursor();
    this.restoreNativeMouse();
    this.inkInstance?.unmount();
    this.inkInstance = undefined;
    this.resolveRenderWaiters(this.renderRevision);
    this.options.onRenderDebug?.({
      phase: "destroyed",
      revision: this.renderRevision,
      committedRevision: this.committedRenderRevision,
      staticCount: staticTranscriptCount(this.state.transcript),
    });
    // Restore cursor/SGR and leave a clean line for the host shell.
    // Do not clear host scrollback: sealed chat history should remain reviewable.
    try {
      this.options.output.write("\x1b[?25h\x1b[0m\n");
    } catch {
      // stdout may already be closed during process teardown
    }
    this.resolveRun?.();
    this.resolveRun = undefined;
  }

  /**
   * Process-level SIGINT while the TUI is active.
   * Ink also delivers Ctrl+C through handleKey; ignore near-duplicate signals so
   * the double-press exit confirmation stays deterministic.
   */
  handleExternalInterrupt(): void {
    this.requestExit();
  }

  private requestExit(): void {
    if (this.destroyed) return;
    const now = Date.now();
    // Collapse dual delivery of the same Ctrl+C (Ink key + process SIGINT).
    if (now - this.lastCancelAt < 50) return;
    if (now - this.lastCancelAt < 1200) {
      this.destroy();
      return;
    }
    this.state.session.status = "press Ctrl+C again to exit";
    this.lastCancelAt = now;
    this.invalidate();
  }

  refreshContext(): void {
    this.state.session.workspace = this.options.getWorkspace();
    this.state.session.modelLabel = this.options.getModelLabel();
    this.state.session.sessionName = this.options.getSessionName?.() ?? this.state.session.sessionName;
    this.state.session.approvalPolicy = this.options.getApprovalPolicy?.() ?? this.state.session.approvalPolicy;
    this.state.session.workMode = this.options.getWorkMode?.() ?? this.state.session.workMode;
    this.state.session.permissionMode = this.options.getPermissionMode?.() ?? this.state.session.permissionMode;
    this.state.session.reasoningEffort = this.options.getReasoningEffort?.() ?? this.state.session.reasoningEffort;
    this.state.session.followUpCount = this.options.getFollowUpCount?.() ?? this.state.session.followUpCount;
    this.state.session.backgroundTasks = this.options.getBackgroundTasks?.() ?? [];
    this.state.commands = [...(this.options.getCommands?.() ?? this.state.commands)];
    const reference = this.options.getModelReference?.();
    if (reference) this.state.session.modelReference = { ...reference };
    else delete this.state.session.modelReference;
    const warning = this.options.getModelWarning?.();
    if (warning) this.state.session.modelWarning = warning;
    else delete this.state.session.modelWarning;
    this.invalidate();
  }

  history(): readonly string[] {
    return this.state.composer.history;
  }

  sessionSnapshot(): SessionView {
    return {
      id: this.state.session.sessionId,
      name: this.state.session.sessionName,
      messages: this.state.transcript.map((message) => ({ ...message })),
      history: [...this.state.composer.history],
      workMode: this.state.session.workMode,
      permissionMode: this.state.session.permissionMode,
      reasoningEffort: this.state.session.reasoningEffort,
      ...(this.state.session.modelReference ? { modelReference: { ...this.state.session.modelReference } } : {}),
    };
  }

  snapshot(): TuiState {
    return this.state;
  }

  handleKey(input: string, key: Key): void {
    if (this.destroyed) return;
    // The raw stream listener owns wheel events; ignore the same sequence if
    // Ink forwards it through useInput so it cannot be mistaken for Escape.
    if (key.ctrl && input === "c") {
      if (this.options.onCancel()) return;
      this.requestExit();
      return;
    }
    // Esc 取消当前任务：连按两次（1.2s 内）才真正取消，第一次仅提示确认。
    // 菜单/弹窗打开时 Esc 仍归对应 handler；空闲时 Esc 仅清空输入框。
    if (key.escape && this.state.overlay.kind === "none" && (this.isBlocked() || isSessionBusy(this.state))) {
      const now = Date.now();
      if (now - this.lastEscapeCancelAt < 1200) {
        this.options.onCancel();
        if (!this.state.session.status) this.state.session.status = "cancelling...";
        this.lastEscapeCancelAt = 0;
      } else {
        this.state.session.status = "press Esc again to cancel";
        this.lastEscapeCancelAt = now;
      }
      this.invalidate();
      return;
    }
    if (this.state.overlay.kind === "approval") {
      this.overlayHandlers.handleApprovalKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "models") {
      this.overlayHandlers.handleModelKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "connect") {
      this.connectWizard.handleKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "sessions") {
      this.overlayHandlers.handleSessionKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "providers") {
      this.overlayHandlers.handleProvidersKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "provider-delete-confirm") {
      void this.overlayHandlers.handleProviderDeleteConfirmKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "session-delete-confirm") {
      void this.overlayHandlers.handleSessionDeleteConfirmKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "follow-ups") {
      void this.overlayHandlers.handleFollowUpKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "commands") {
      this.overlayHandlers.handleCommandKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "files") {
      this.overlayHandlers.handleFileKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "details") {
      if (key.escape || (key.ctrl && input === "t")) {
        setOverlay(this.state, { kind: "none" });
        this.invalidate();
      }
      return;
    }
    if (key.ctrl && input === "q") {
      void this.overlayHandlers.openFollowUps();
      return;
    }
    if (key.ctrl && input === "t") {
      this.openLatestActivityDetails();
      return;
    }
    if (key.shift && key.tab) {
      void this.toggleReasoningEffort();
      return;
    }
    if (key.tab && !key.shift) {
      void this.toggleWorkMode();
      return;
    }
    this.handleComposerKey(input, key);
  }

  async openConnect(prefill?: ConnectPrefill): Promise<void> {
    this.connectWizard.open(prefill);
  }

  async openProviders(): Promise<void> {
    await this.overlayHandlers.openProviders();
  }

  async openModels(): Promise<void> {
    await this.overlayHandlers.openModels();
  }

  async openSessions(): Promise<void> {
    await this.overlayHandlers.openSessions();
  }

  private handleComposerKey(input: string, key: Key): void {
    if (isSubmitKey(input, key)) {
      if (key.shift || (key.ctrl && (input === "j" || input === "\n"))) {
        this.detachInputHistory();
        insertText(this.state.composer, "\n");
      } else void this.submit();
    } else if (key.ctrl && input === "j") {
      this.detachInputHistory();
      insertText(this.state.composer, "\n");
    } else if (isDeleteBackward(input, key)) {
      this.detachInputHistory();
      deleteBackward(this.state.composer);
    } else if (isDeleteForward(input, key)) {
      this.detachInputHistory();
      deleteForward(this.state.composer);
    } else if (key.pageUp) this.scrollTranscriptBy(this.pageScrollDelta());
    else if (key.pageDown) this.scrollTranscriptBy(-this.pageScrollDelta());
    else if (key.ctrl && key.upArrow) this.scrollTranscriptBy(3);
    else if (key.ctrl && key.downArrow) this.scrollTranscriptBy(-3);
    else if (key.leftArrow) moveCursor(this.state.composer, "left");
    else if (key.rightArrow) moveCursor(this.state.composer, "right");
    else if (key.upArrow) {
      if (this.canMoveComposerVertically("up")) moveCursor(this.state.composer, "up", this.editorWidth());
      else this.navigateInputHistory("older");
    } else if (key.downArrow) {
      if (this.canMoveComposerVertically("down")) moveCursor(this.state.composer, "down", this.editorWidth());
      else this.navigateInputHistory("newer");
    } else if (isHomeKey(input, key)) moveToLineEdge(this.state.composer, "start");
    else if (isEndKey(input, key)) moveToLineEdge(this.state.composer, "end");
    else if (key.escape) {
      // Idle Esc clears the draft; busy Esc is handled in handleKey before this.
      this.detachInputHistory();
      setComposerValue(this.state.composer, "");
      this.state.composer.pastes = [];
    } else if (input && !key.ctrl && !key.meta) {
      // Multi-char payloads are paste events from Ink; keep newlines intact.
      if (input === "\r" || input === "\n") {
        // bare CR/LF already handled as submit above
      } else if (input.includes("\n") || input.length > PASTE_FOLD_CHARS) {
        // Fold large pastes into a short placeholder; the raw text is sent to
        // the model on submit via expandPastes.
        this.detachInputHistory();
        insertText(this.state.composer, registerPaste(this.state.composer, input));
      } else {
        this.detachInputHistory();
        insertText(this.state.composer, input);
      }
    }
    this.updateComposerOverlay();
    this.invalidate();
  }

  private updateComposerOverlay(): void {
    const value = composerValue(this.state.composer);
    const file = fileQuery(value, composerCursorOffset(this.state.composer));
    if (file && this.options.loadFiles) {
      const previous = this.state.overlay.kind === "files" ? this.state.overlay : undefined;
      const sameQuery = previous?.query === file.query;
      this.state.overlay = {
        kind: "files",
        query: file.query,
        selectedIndex: sameQuery ? previous.selectedIndex : 0,
        options: sameQuery ? previous.options : [],
        loading: true,
        tokenStart: file.start,
      };
      void this.options
        .loadFiles(file.query)
        .then((options) => {
          if (
            this.state.overlay.kind === "files" &&
            this.state.overlay.query === file.query &&
            this.state.overlay.tokenStart === file.start
          ) {
            this.state.overlay = { ...this.state.overlay, options, loading: false };
            this.invalidate();
          }
        })
        .catch((error: unknown) => {
          if (
            this.state.overlay.kind === "files" &&
            this.state.overlay.query === file.query &&
            this.state.overlay.tokenStart === file.start
          ) {
            this.state.overlay = { ...this.state.overlay, options: [], loading: false };
            this.state.session.status = errorMessage(error);
            this.invalidate();
          }
        });
      return;
    }
    if (value.startsWith("/") && !value.includes(" ") && !value.includes("\n")) {
      if (this.dismissedCommandInput === value) return;
      this.dismissedCommandInput = undefined;
      const previousQuery = this.state.overlay.kind === "commands" ? this.state.overlay.query : "";
      const previousIndex = this.state.overlay.kind === "commands" ? this.state.overlay.selectedIndex : 0;
      const candidates = commandCandidates(value, this.state.commands);
      setOverlay(this.state, {
        kind: "commands",
        query: value,
        selectedIndex: Math.min(candidates.length - 1, Math.max(0, previousQuery === value ? previousIndex : 0)),
      });
      return;
    }
    if (this.state.overlay.kind === "commands" || this.state.overlay.kind === "files")
      this.state.overlay = { kind: "none" };
  }

  restoreSessionView(session: SessionView, notice?: string): void {
    this.restoreSession(session);
    if (notice) appendSystemMessage(this.state, notice, "system");
    this.invalidate();
  }

  private restoreSession(session: SessionView): void {
    const previousTaskId = this.state.activeTaskId;
    if (previousTaskId) this.state.retiredTaskIds.add(previousTaskId);
    this.state.session.sessionId = session.id;
    this.state.session.sessionName = session.name;
    this.state.session.workMode = session.workMode ?? this.options.getWorkMode?.() ?? this.state.session.workMode;
    this.state.session.permissionMode =
      session.permissionMode ??
      this.options.getPermissionMode?.() ??
      (this.state.session.workMode === "plan" ? "plan" : "default");
    this.state.session.reasoningEffort =
      session.reasoningEffort ?? this.options.getReasoningEffort?.() ?? this.state.session.reasoningEffort;
    if (session.modelReference) this.state.session.modelReference = { ...session.modelReference };
    else delete this.state.session.modelReference;
    if (session.modelWarning) this.state.session.modelWarning = session.modelWarning;
    else delete this.state.session.modelWarning;
    this.state.transcript = session.messages
      .filter((message) => !isTransientRestoredMessage(message))
      .map((message) => ({ ...message }));
    this.state.expandedToolGroupIds.clear();
    if (
      session.modelWarning &&
      !this.state.transcript.some((message) => message.kind === "error" && message.text === session.modelWarning)
    ) {
      appendSystemMessage(this.state, session.modelWarning, "error");
    }
    this.state.composer.history = [...session.history];
    this.state.composer.historyIndex = undefined;
    this.state.composer.historyDraft = "";
    setComposerValue(this.state.composer, "");
    this.state.composer.pastes = [];
    this.state.nextMessageId = nextMessageNumber(this.state.transcript);
    this.state.assistantMessageId = undefined;
    this.state.thoughtMessageId = undefined;
    this.state.streaming = false;
    this.state.activeTaskId = undefined;
    this.state.activeTaskUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.state.lastSequence = 0;
    this.state.processedSequences.clear();
    this.state.session.taskState = "ready";
    this.state.session.status = "";
    this.state.session.currentStep = undefined;
    this.state.session.currentTool = undefined;
    this.state.session.startedAt = undefined;
    this.state.session.elapsedMs = undefined;
    this.state.session.modelElapsedMs = undefined;
    this.state.session.outputTokensPerSecond = undefined;
    this.state.session.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.state.session.followUpCount = this.options.getFollowUpCount?.() ?? 0;
    this.state.overlay = { kind: "none" };
    this.resetStaticTranscript();
    this.invalidate();
    this.refreshContext();
  }

  private async submit(forcedCommand?: string): Promise<void> {
    // Task/approval interactions still accept free-text so session can queue follow-ups.
    // Only block concurrent submits from the composer itself.
    if (this.submitBusy) return;
    // Expand folded paste placeholders back to their raw text before sending;
    // the composer only ever shows the short [paste #N +M lines] summary.
    const value = forcedCommand
      ? forcedCommand.trim()
      : expandPastes(composerValue(this.state.composer), this.state.composer.pastes).trim();
    if (!value) return;
    this.submitBusy = true;
    const previousValue = composerValue(this.state.composer);
    this.state.composer.historyIndex = undefined;
    this.state.composer.historyDraft = "";
    setComposerValue(this.state.composer, "");
    this.state.overlay = { kind: "none" };
    this.state.transcriptScroll = { offsetFromBottom: 0, followBottom: true };
    this.invalidate();
    let accepted = false;
    try {
      await this.options.onInput(value);
      accepted = true;
      // Pastes are cleared only on success; on failure the composer is
      // restored with its placeholders so they can be re-expanded.
      this.state.composer.pastes = [];
      this.state.composer.history = [value, ...this.state.composer.history.filter((entry) => entry !== value)].slice(
        0,
        1000,
      );
      this.refreshContext();
    } catch (error) {
      if (!accepted) setComposerValue(this.state.composer, previousValue || value);
      this.state.session.status = errorMessage(error);
    } finally {
      this.submitBusy = false;
      this.invalidate();
    }
  }

  private async toggleWorkMode(): Promise<void> {
    const current = this.options.getWorkMode?.() ?? this.state.session.workMode;
    const next: WorkMode = current === "plan" ? "auto" : "plan";
    try {
      const changed = await this.options.onWorkModeChanged?.(next);
      if (changed === false) {
        this.state.session.status = "finish or cancel the current task before switching mode";
        this.invalidate();
        return;
      }
      if (changed) {
        this.state.session.workMode = next;
        if (next === "plan") this.state.session.permissionMode = "plan";
        else if (this.state.session.permissionMode === "plan") this.state.session.permissionMode = "default";
        this.state.session.status = next;
        this.refreshContext();
      }
    } catch (error) {
      this.state.session.status = errorMessage(error);
      this.invalidate();
    }
  }

  private async toggleReasoningEffort(): Promise<void> {
    const current = this.options.getReasoningEffort?.() ?? this.state.session.reasoningEffort;
    const index = REASONING_EFFORTS.indexOf(current);
    const next = REASONING_EFFORTS[(index + 1) % REASONING_EFFORTS.length] ?? "medium";
    try {
      const changed = await this.options.onReasoningEffortChanged?.(next);
      if (changed === false) {
        this.state.session.status = "finish or cancel the current task before changing thinking strength";
        this.invalidate();
        return;
      }
      if (changed) {
        this.state.session.reasoningEffort = next;
        this.state.session.status = next;
        this.refreshContext();
      }
    } catch (error) {
      this.state.session.status = errorMessage(error);
      this.invalidate();
    }
  }

  private openApproval(
    call: ToolCall,
    level: number,
    description: string,
    origin: SubagentOrigin,
  ): Promise<ApprovalResponse> {
    // Replace any previous unresolved approval promise so callers never hang.
    this.cancelApproval();
    this.state.overlay = {
      kind: "approval",
      approval: { call, level, description, workspace: this.options.getWorkspace(), origin },
      selectedIndex: 0,
    };
    this.state.session.status = "approval required";
    this.invalidate();
    return new Promise<ApprovalResponse>((resolve) => {
      this.approvalResolve = resolve;
    });
  }

  private resolveApproval(response: ApprovalResponse): void {
    const resolve = this.approvalResolve;
    if (!resolve) return;
    this.approvalResolve = undefined;
    this.state.overlay = { kind: "none" };
    resolve(response);
    this.invalidate();
  }

  private cancelApproval(): void {
    if (!this.approvalResolve) return;
    this.resolveApproval(false);
  }

  private isBlocked(): boolean {
    return this.options.isInteractionBlocked?.() === true;
  }

  private rejectIfBlocked(message: string): boolean {
    if (!this.isBlocked()) return false;
    this.state.session.status = message;
    this.invalidate();
    return true;
  }

  private editorWidth(): number {
    return Math.max(20, (this.options.output.columns || 80) - 4);
  }

  private navigateInputHistory(direction: "older" | "newer"): void {
    const next = navigateHistory(
      this.state.composer.history,
      this.state.composer.historyIndex,
      direction,
      composerValue(this.state.composer),
      this.state.composer.historyDraft,
    );
    setComposerValue(this.state.composer, next.value);
    this.state.composer.pastes = [];
    this.state.composer.historyIndex = next.index;
    this.state.composer.historyDraft = next.draft;
    this.updateComposerOverlay();
  }

  private detachInputHistory(): void {
    this.state.composer.historyIndex = undefined;
    this.state.composer.historyDraft = "";
  }

  private canMoveComposerVertically(direction: "up" | "down"): boolean {
    const lines = visualLines(this.state.composer, this.editorWidth());
    if (lines.length <= 1) return false;
    const position = cursorVisualPosition(this.state.composer, this.editorWidth());
    return direction === "up" ? position.row > 0 : position.row < lines.length - 1;
  }

  private invalidate(): void {
    // Ink eraseLines starts from the real cursor. Unpark first so redraws do not
    // carve out the middle of the frame when the caret was moved onto the composer.
    this.unparkComposerCursor();
    this.renderRevision += 1;
    if (!this.inkInstance || this.renderScheduled) return;
    this.renderScheduled = true;
    // Keep the scheduler occupied through Ink's deferred commit so bursted
    // deltas collapse into one frame; boundary events explicitly wait here.
    queueMicrotask(() => {
      const revision = this.renderRevision;
      // 捕获后立即释放调度位:Ink reconciler/stdout 写入的提交窗口内新到的
      // invalidate 必须重新排队渲染。否则窗口内被吞掉的 revision 永远没有
      // 提交帧,等待它的 flushPendingRender waiter 会把运行时事件永久挂起
      // (表现为任务完成后 TUI 不再推进,直到手动停止触发 destroy 兜底)。
      this.renderScheduled = false;
      if (this.destroyed || !this.inkInstance) {
        this.resolveRenderWaiters(revision);
        return;
      }
      try {
        this.inkInstance.rerender(<InkRoot app={this} revision={revision} />);
      } catch (error) {
        // Never leave an awaited runtime event blocked behind a failed render.
        // Resolve this revision before allowing Ink's render error to surface.
        this.renderScheduled = false;
        this.resolveRenderWaiters(revision);
        throw error;
      }
      // Let Ink's reconciler/stdout writer commit before the awaited provider
      // callback accepts another streamed delta.
      setImmediate(() => {
        this.renderScheduled = false;
        this.resolveRenderWaiters(revision);
        this.options.onRenderDebug?.({
          phase: "committed",
          revision,
          committedRevision: this.committedRenderRevision,
          staticCount: staticTranscriptCount(this.state.transcript),
        });
      });
    });
  }

  async flushPendingRender(commit: TuiRenderCommitKind = "normal"): Promise<void> {
    const revision = this.renderRevision;
    if (!this.inkInstance || this.destroyed) return;
    if (commit === "normal") return;
    if (this.committedRenderRevision < revision) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const index = this.renderWaiters.findIndex((waiter) => waiter.resolve === settle);
          if (index >= 0) this.renderWaiters.splice(index, 1);
          // 兜底:提交帧迟迟未到时不得让运行时事件挂在渲染上;
          // 强制补一次渲染,让可能被吞掉的 revision 也有提交机会。
          this.options.onRenderDebug?.({
            phase: "render_wait_timeout",
            revision,
            committedRevision: this.committedRenderRevision,
            staticCount: staticTranscriptCount(this.state.transcript),
          });
          this.invalidate();
          settle();
        }, RENDER_WAIT_TIMEOUT_MS);
        timer.unref?.();
        const settle = (): void => {
          clearTimeout(timer);
          resolve();
        };
        this.renderWaiters.push({ revision, resolve: settle });
      });
    }
    if (commit === "terminal" && !this.destroyed && this.inkInstance) {
      await new Promise<void>((resolve) => setTimeout(resolve, INK_PAINT_BARRIER_MS));
    }
  }

  private resolveRenderWaiters(revision: number): void {
    this.committedRenderRevision = Math.max(this.committedRenderRevision, revision);
    for (let index = this.renderWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.renderWaiters[index];
      if (!waiter || waiter.revision > this.committedRenderRevision) continue;
      this.renderWaiters.splice(index, 1);
      waiter.resolve();
    }
  }

  private restoreNativeMouse(): void {
    if (!this.options.output.isTTY) return;
    try {
      this.options.output.write(RESTORE_NATIVE_MOUSE);
    } catch {
      // stdout may already be closed during process teardown
    }
  }

  /**
   * Park the hidden terminal cursor on the composer caret for IME anchoring.
   * Windows IME candidate/pinyin UI follows the real cursor, not a fake inverse caret.
   *
   * Strategy: DECSC save at Ink's post-frame position, CUU/CHA onto the caret, then
   * DECRC on unpark. Relative-only up/down drifted after viewport/footer changes.
   * `up` is lines above the blank line Ink leaves after the frame; `column` is 1-based.
   */
  parkComposerCursor(up: number, column: number): void {
    if (this.destroyed || !this.inkInstance) return;
    const safeUp = Math.max(0, Math.floor(up));
    const safeColumn = Math.max(1, Math.floor(column));
    try {
      // Always restore first so we never stack relative moves on a parked caret.
      this.unparkComposerCursor();
      // Save Ink's after-frame position, move onto the composer, and stay hidden.
      this.options.output.write(`\x1b7\x1b[${safeUp}A\x1b[${safeColumn}G\x1b[?25l`);
      this.parkedComposerCursor = true;
    } catch {
      this.parkedComposerCursor = false;
    }
  }

  /** Return the real cursor to the blank line after the Ink frame and hide it. */
  unparkComposerCursor(): void {
    if (!this.parkedComposerCursor) return;
    this.parkedComposerCursor = false;
    try {
      // DECRC restores the post-frame position saved in parkComposerCursor.
      this.options.output.write("\x1b8\x1b[?25l");
    } catch {
      // stdout may already be closed during teardown
    }
  }

  /** Full rendered transcript as display lines. */
  transcriptLines(width = Math.max(20, (this.options.output.columns || 80) - 2)): string[] {
    return this.transcript.lines(this.state, width);
  }

  scrollState(): TuiState["transcriptScroll"] {
    return this.state.transcriptScroll;
  }

  syncViewportScroll(renderedLines: ReturnType<TranscriptView["linesWithAnchors"]>, viewportLines: number): void {
    const contentLines = renderedLines.length;
    const maximumOffset = Math.max(0, contentLines - Math.max(1, viewportLines));
    const anchor = this.state.transcriptScroll.anchor;
    if (anchor && !this.state.transcriptScroll.followBottom) {
      const anchoredLine = findAnchoredLine(renderedLines, anchor.messageId, anchor.lineOffset);
      if (anchoredLine >= 0) {
        this.state.transcriptScroll.offsetFromBottom = Math.max(0, maximumOffset - anchoredLine);
      }
    }
    syncTranscriptScroll(this.state.transcriptScroll, contentLines, viewportLines, this.state.lastTranscriptLines);
    this.state.lastTranscriptLines = contentLines;
    this.state.lastTranscriptViewportLines = viewportLines;
    this.lastTranscriptRenderLines = renderedLines;
  }

  scrollTranscriptBy(delta: number): void {
    const width = Math.max(20, (this.options.output.columns || 80) - 2);
    const rows = Math.max(1, this.options.output.rows || 24);
    // Use the height measured by the last completed frame. Footer wrapping,
    // multiline input, overlays, and the history indicator all change the
    // actual transcript viewport, so estimating from terminal rows can turn a
    // single PageUp into a jump to the beginning.
    const viewportLines = Math.max(1, this.state.lastTranscriptViewportLines || rows - 6);
    const renderedLines = this.transcript.linesWithAnchors(this.state, width);
    const maximum = Math.max(0, renderedLines.length - viewportLines);
    const before = this.state.transcriptScroll.offsetFromBottom;
    scrollTranscript(this.state.transcriptScroll, delta, maximum);
    this.state.lastTranscriptLines = renderedLines.length;
    this.state.lastTranscriptViewportLines = viewportLines;
    this.lastTranscriptRenderLines = renderedLines;
    this.captureTranscriptAnchor();
    if (this.state.transcriptScroll.offsetFromBottom !== before) this.invalidate();
  }

  transcriptRenderSections(
    width: number,
    liveTick = 0,
  ): {
    staticItems: StaticTranscriptItem[];
    liveLines: ReturnType<TranscriptView["linesWithAnchors"]>;
  } {
    const lines = this.transcript.linesWithAnchors(this.state, Math.max(12, width), liveTick);
    const candidateStaticCount = staticTranscriptCount(this.state.transcript);
    const staticMessages = this.state.transcript.slice(0, candidateStaticCount);
    const groupedLines = new Map<string, string[]>();

    for (const line of lines) {
      const messageLines = groupedLines.get(line.messageId) ?? [];
      messageLines.push(line.text);
      groupedLines.set(line.messageId, messageLines);
    }

    const newItems: StaticTranscriptItem[] = [];
    for (const message of staticMessages) {
      if (this.committedStaticTranscriptIds.has(message.id)) continue;
      this.committedStaticTranscriptIds.add(message.id);
      const messageLines = groupedLines.get(message.id);
      if (messageLines?.length) newItems.push({ id: message.id, text: messageLines.join("\n") });
    }
    if (newItems.length) this.committedStaticTranscriptItems = [...this.committedStaticTranscriptItems, ...newItems];
    return {
      staticItems: this.committedStaticTranscriptItems,
      liveLines: lines.filter((line) => !this.committedStaticTranscriptIds.has(line.messageId)),
    };
  }

  staticTranscriptKey(): number {
    return this.staticTranscriptGeneration;
  }

  private openLatestActivityDetails(): void {
    const target = [...this.state.transcript]
      .reverse()
      .find((message) => message.kind === "thought" || message.kind === "tool");
    if (!target) {
      this.state.session.status = "no thought or tool details available";
      this.invalidate();
      return;
    }

    const segment = collapsibleSegments(this.state.transcript).find((entry) =>
      entry.messages.some((message) => message.id === target.id),
    );
    const detailMessages = (segment?.messages ?? [target]).map((message) =>
      message.kind === "thought" || message.kind === "tool" ? { ...message, expanded: true } : { ...message },
    );
    const width = Math.max(20, (this.options.output.columns || 80) - 2);
    const lines = new TranscriptView()
      .renderLines(detailMessages, width, 0, segment ? new Set([segment.id]) : new Set())
      .map((line) => line.text);
    const title = segment ? "Latest activity" : target.kind === "tool" ? `Tool: ${target.name}` : "Thought";

    setOverlay(this.state, { kind: "details", title, lines });
    this.invalidate();
  }

  private pageScrollDelta(): number {
    const rows = Math.max(1, this.options.output.rows || 24);
    const viewportLines = Math.max(1, this.state.lastTranscriptViewportLines || rows - 6);
    // Keep two lines of context between pages so the user's eye can retain its
    // position while reviewing a long response.
    return Math.max(1, viewportLines - 2);
  }

  private captureTranscriptAnchor(): void {
    if (this.state.transcriptScroll.followBottom || !this.lastTranscriptRenderLines.length) {
      this.state.transcriptScroll.anchor = undefined;
      return;
    }
    const top = Math.max(
      0,
      this.lastTranscriptRenderLines.length -
        this.state.lastTranscriptViewportLines -
        this.state.transcriptScroll.offsetFromBottom,
    );
    const line = this.lastTranscriptRenderLines[Math.min(top, this.lastTranscriptRenderLines.length - 1)];
    this.state.transcriptScroll.anchor = line ? { messageId: line.messageId, lineOffset: line.lineOffset } : undefined;
  }

  private resetStaticTranscript(): void {
    this.staticTranscriptGeneration += 1;
    this.committedStaticTranscriptItems = [];
    this.committedStaticTranscriptIds.clear();
    this.resetTranscriptViewport();
  }

  private resetTranscriptViewport(): void {
    this.state.transcriptScroll = { offsetFromBottom: 0, followBottom: true };
    this.state.lastTranscriptLines = 0;
    this.state.lastTranscriptViewportLines = 0;
    this.lastTranscriptRenderLines = [];
  }
}

function findAnchoredLine(
  lines: ReturnType<TranscriptView["linesWithAnchors"]>,
  messageId: string,
  lineOffset: number,
): number {
  const exact = lines.findIndex((line) => line.messageId === messageId && line.lineOffset === lineOffset);
  if (exact >= 0) return exact;

  let first = -1;
  let last = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.messageId !== messageId) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0) return -1;
  return Math.min(last, first + Math.max(0, lineOffset));
}

/**
 * Transient failure artifacts (retry notices, abort-only turns, stale
 * "Restored session" system lines) should not resurface when a session is
 * loaded again — a later successful reply supersedes them.
 */
function isTransientRestoredMessage(message: TranscriptMessage): boolean {
  if (message.kind === "system" && message.text.startsWith("Restored session ")) return true;
  if (message.kind === "error") {
    const text = message.text;
    return (
      /^Attempt \d+\/\d+ failed/.test(text) || // legacy retry notice
      /^retrying \(\d+\/\d+\)/.test(text) || // current retry notice
      /\nRetrying \(\d+\/\d+\)/.test(text) // legacy multi-line retry
    );
  }
  if (message.kind === "assistant" && message.abortMessage !== undefined && !message.streaming) {
    const trimmed = message.text.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) return true;
  }
  return false;
}

/** Pastes longer than this many characters (or any multi-line paste) fold. */
const PASTE_FOLD_CHARS = 100;

/** Register a folded paste payload and return its short placeholder text. */
function registerPaste(composer: ComposerState, text: string): string {
  const index = composer.pastes.length + 1;
  const lineCount = text.split(/\r?\n/).length;
  composer.pastes.push({ text });
  return `[paste #${index} +${lineCount} lines]`;
}

/** Replace [paste #N +M lines] placeholders with the raw payloads they stand for. */
function expandPastes(value: string, pastes: readonly PasteBlock[]): string {
  if (!pastes.length || !value.includes("[paste #")) return value;
  return value.replace(/\[paste #(\d+) \+\d+ lines\]/g, (match, rawIndex) => {
    const index = Number(rawIndex) - 1;
    return pastes[index]?.text ?? match;
  });
}

function errorMessage(error: unknown): string {
  // Footer/status lines are single-line truncated; keep the headline only there.
  return formatErrorMessage(error);
}

/** ink 的 color prop 在 exactOptionalPropertyTypes 下不接受显式 undefined;单色主题时按需省略。 */
function colorProps(color: string | undefined): { color: string } | Record<string, never> {
  return color !== undefined ? { color } : {};
}

function InkRoot({ app, revision }: { app: InkTuiApp; revision: number }): React.JSX.Element {
  void revision;
  const [spinnerTick, setSpinnerTick] = useState(0);
  const { stdout } = useStdout();
  // Track terminal size in React state so transcript wrapping and viewport math
  // update in the same render.
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  }));
  const state = app.snapshot();
  const busy = isSessionBusy(state);
  const activeSpinner = busy || hasActiveBackgroundTasks(state);
  useEffect(() => {
    const stream = stdout as NodeJS.WriteStream & {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    if (typeof stream.on !== "function" || typeof stream.off !== "function") return;
    const onResize = () => {
      app.unparkComposerCursor();
      setTerminalSize({
        columns: stream.columns || 80,
        rows: stream.rows || 24,
      });
    };
    stream.on("resize", onResize);
    return () => {
      stream.off?.("resize", onResize);
    };
  }, [app, stdout]);
  useInput((input, key) => app.handleKey(input, key));

  const terminalWidth = Math.max(20, terminalSize.columns || stdout.columns || 80);
  const rows = Math.max(1, terminalSize.rows || stdout.rows || 24);
  // All TUI regions share one content width. The outer frame reserves one cell
  // on each side; composer text additionally reserves the two-cell prompt.
  const width = terminalWidth - 2;
  const editorWidth = Math.max(1, width - 2);
  const editorLines = visualLines(state.composer, editorWidth);
  const cursor = cursorVisualPosition(state.composer, editorWidth);
  const footer = footerLines(state, width);
  const summary = workSummaryLine(state);
  const workingLine = workingIndicatorLine(state, spinnerTick);
  useEffect(() => {
    if (!activeSpinner) return;
    // The same tick animates the fallback Working line, Subagent indicator, and live Thought/Tool rows.
    const timer = setInterval(() => setSpinnerTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [activeSpinner]);
  const transcript = app.transcriptRenderSections(width, spinnerTick);
  const transcriptLines = transcript.liveLines;
  const welcomeLines =
    state.transcript.length === 0 && state.overlay.kind === "none" ? oranWelcomeLines(state, width) : [];
  const showScrollStatus = state.transcriptScroll.offsetFromBottom > 0;
  const summaryLine = summary;
  // Count the actual chrome rows rendered below the transcript. Keeping this
  // derived from the rendered pieces prevents long composers/footers from
  // stealing rows from the transcript or pushing the prompt off-screen.
  const baseChromeLines =
    (showScrollStatus ? 1 : 0) +
    (workingLine ? 1 : 0) +
    (summaryLine ? 1 : 0) +
    1 + // upper rule
    Math.max(1, editorLines.length) +
    1 + // lower rule
    footer.length;
  // Reserve one row for the overlay margin. Candidate lists are windowed so a
  // short terminal never pushes the composer away.
  const overlayCapacity = Math.max(1, rows - baseChromeLines - 1);
  const commandItemCapacity = Math.max(1, Math.min(7, overlayCapacity - 2));
  const commandLines =
    state.overlay.kind === "commands"
      ? commandPaletteLines(
          state.overlay.query,
          state.overlay.selectedIndex,
          state.commands,
          width,
          commandItemCapacity,
        )
      : [];
  const overlayLines = fitOverlayLines(renderOverlayLines(state, commandLines, width), overlayCapacity);
  // Keep the mutable frame below the terminal height so Ink never enters its
  // clearTerminal paint path. The completed form is emitted to Static in full.
  const viewportLines = Math.max(1, rows - baseChromeLines - (overlayLines.length > 0 ? overlayLines.length + 1 : 0));
  app.syncViewportScroll(transcriptLines, viewportLines);
  const maximumStart = Math.max(0, transcriptLines.length - viewportLines);
  const viewportStart = Math.max(0, maximumStart - Math.min(maximumStart, state.transcriptScroll.offsetFromBottom));
  const visibleTranscriptLines = transcriptLines
    .slice(viewportStart, viewportStart + viewportLines)
    .map((line) => line.text);
  const scrollStatusLine = showScrollStatus
    ? `↑ History · ${Math.round(scrollPercent(state.transcriptScroll.offsetFromBottom, transcriptLines.length, viewportLines))}% · PageDown to return`
    : undefined;

  // After Ink paints (~32ms throttle), park the real cursor on the composer caret so
  // Windows IME candidate/pinyin UI anchors to the input line. Skip while busy: the
  // spinner re-renders without going through invalidate(), and a mid-frame caret would
  // make Ink eraseLines corrupt the chrome.
  //
  // Ink's log-update path leaves the cursor on a blank line after the frame, but
  // Ink writes a full-height frame directly without that trailing newline. Account
  // for both baselines so IME composition does not jump onto the upper input rule
  // once a long conversation fills the terminal.
  //   footer lines -> bottom rule -> composer rows below the caret.
  // Column is absolute CHA: prompt ("> ") is 2 cells, then display-width offset.
  const composerLineCount = Math.max(1, editorLines.length);
  const frameHeight =
    visibleTranscriptLines.length +
    baseChromeLines +
    (overlayLines.length > 0 ? overlayLines.length + 1 : 0) +
    (visibleTranscriptLines.length === 0 && overlayLines.length === 0 ? 1 : 0);
  const frameEndOffset = frameHeight >= rows ? 1 : 2;
  const parkUp = footer.length + frameEndOffset + Math.max(0, composerLineCount - 1 - cursor.row);
  const parkColumn = 1 + 2 + Math.max(0, cursor.column);
  useEffect(() => {
    if (busy || state.overlay.kind === "approval") {
      app.unparkComposerCursor();
      return;
    }
    // Two-phase park: wait for Ink's render throttle, then one more frame so yoga
    // width and log-update have settled before DECSC/CUU.
    let second: ReturnType<typeof setTimeout> | undefined;
    const first = setTimeout(() => {
      second = setTimeout(() => {
        app.parkComposerCursor(parkUp, parkColumn);
      }, 16);
    }, 32);
    return () => {
      clearTimeout(first);
      if (second) clearTimeout(second);
      app.unparkComposerCursor();
    };
  }, [
    app,
    parkUp,
    parkColumn,
    visibleTranscriptLines.length,
    overlayLines.length,
    workingLine,
    summaryLine,
    busy,
    state.overlay.kind,
    editorLines.length,
    footer.length,
  ]);

  return (
    <Box flexDirection="column" width="100%">
      <Static key={`${state.session.sessionId}:${app.staticTranscriptKey()}`} items={transcript.staticItems}>
        {(item) => <Text key={item.id}>{item.text}</Text>}
      </Static>
      {welcomeLines.length > 0 ? <Text>{welcomeLines.join("\n")}</Text> : null}
      {visibleTranscriptLines.length > 0 ? <Text>{visibleTranscriptLines.join("\n")}</Text> : null}
      {overlayLines.length > 0 && (
        <Box flexDirection="column" flexShrink={0} marginBottom={1}>
          {overlayLines.map((line, index) => (
            <HighlightedLine key={`overlay-${index}`} value={line} />
          ))}
        </Box>
      )}
      <Box
        flexDirection="column"
        flexShrink={0}
        marginTop={visibleTranscriptLines.length > 0 || overlayLines.length > 0 ? 0 : 1}
      >
        {scrollStatusLine ? <Text {...colorProps(COLORS.accentDim)}>{scrollStatusLine}</Text> : null}
        {workingLine ? <Text {...colorProps(COLORS.activity)}>{workingLine}</Text> : null}
        {summaryLine ? <Text {...colorProps(COLORS.success)}>{summaryLine}</Text> : null}
        <Text dimColor>{horizontalRule(width)}</Text>
        <Text>
          <Text {...colorProps(COLORS.accent)} bold>
            {composerPrefix(state.overlay.kind).trimEnd()}
          </Text>
          <Text>
            {composerPrefix(state.overlay.kind).endsWith(" ") ? " " : ""}
            {renderComposerLines(editorLines, cursor.row, cursor.column, busy)}
          </Text>
          {ghostCommandSuggestion(state, composerValue(state.composer)) ? (
            <Text dimColor>{ghostCommandSuggestion(state, composerValue(state.composer))}</Text>
          ) : null}
        </Text>
        <Text dimColor>{horizontalRule(width)}</Text>
        {footer.map((line, index) =>
          index === 0 ? (
            <Text key={`footer-${index}`} {...colorProps(COLORS.accentDim)}>
              {line}
            </Text>
          ) : (
            <Text key={`footer-${index}`} dimColor>
              {line}
            </Text>
          ),
        )}
      </Box>
    </Box>
  );
}
