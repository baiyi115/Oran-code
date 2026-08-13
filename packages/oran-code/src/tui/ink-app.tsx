import React, { useEffect, useState } from "react";
import { Box, Static, Text, render, useInput, useStdout, type Key } from "ink";
import type { ApprovalResponse, ToolCall } from "../types.js";
import { REASONING_EFFORTS, type WorkMode } from "../types.js";
import { formatErrorMessage } from "../error-format.js";
import { commandCandidates } from "./command-palette.js";
import { approvalResponse, moveSelection, navigateHistory } from "./interaction.js";
import { TuiTranscriptRenderer } from "./renderer.js";
import { composerValue, createTuiState, setComposerValue, setOverlay } from "./state.js";
import type { SessionOption, SessionView, TuiAppOptions, TuiState, TranscriptMessage } from "./types.js";
import { appendSystemMessage } from "./message-reducer.js";
import { composerCursorOffset, cursorVisualPosition, deleteBackward, deleteForward, insertText, moveCursor, moveToLineEdge, visualLines } from "./composer.js";
import { TranscriptView, toolGroupId, toolGroups } from "./transcript/transcript-view.js";
import { footerLines, workSummaryLine } from "./footer.js";
import { approvalDialogLines } from "./approval-dialog.js";
import type { SubagentOrigin } from "../subagent/types.js";
import { modelSelectorLines } from "./model-selector.js";
import { commandPaletteLines } from "./command-palette.js";
import { ANSI, COLORS, horizontalRule } from "./theme.js";
import { highlightSelection } from "./overlay/select-list.js";
import { graphemes, truncateVisible, visibleWidth } from "./text-width.js";
import { scrollPercent, scrollTranscript, syncTranscriptScroll } from "./scroll-controller.js";
import { currentSessionLine, sessionOptionLabel } from "./session-list.js";
import { isSessionBusy, workingIndicatorLine } from "./status-indicator.js";

interface InkTuiAppDependencies {
  render?: typeof render;
}

interface StaticTranscriptItem {
  id: string;
  text: string;
}

// Mouse reporting prevents the terminal emulator from starting its native text
// selection. Clear every common tracking mode in case a previous process exited
// before restoring the terminal.
const RESTORE_NATIVE_MOUSE = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1015l\x1b[?1006l\x1b[?1005l";
// Ink 5 throttles its real stdout paint by 32ms but does not expose
// waitUntilRenderFlush(). Boundary events wait past that window so a short,
// burst-delivered response cannot skip directly to its completed frame.
const INK_PAINT_BARRIER_MS = 40;

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
  private readonly state: TuiState;
  private readonly transcript = new TranscriptView();
  private readonly renderInk: typeof render;
  private inkInstance: ReturnType<typeof render> | undefined;
  private resolveRun: (() => void) | undefined;
  private approvalResolve: ((response: ApprovalResponse) => void) | undefined;
  private destroyed = false;
  private commandIndex = 0;
  private dismissedCommandInput: string | undefined;
  private modelIndex = 0;
  private sessionIndex = 0;
  private lastCancelAt = 0;
  /** True while the real caret is parked on the composer via DECSC/DECRC. */
  private parkedComposerCursor = false;
  private lastEscapeCancelAt = 0;
  private followUpBusy = false;
  private deletingSession = false;
  private selectingSession = false;
  private submitBusy = false;
  private renderScheduled = false;
  private renderRevision = 0;
  private committedRenderRevision = 0;
  private staticTranscriptGeneration = 0;
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
    this.state.commands = [...(options.getCommands?.() ?? this.state.commands)];
    if (options.initialSession?.modelWarning) {
      appendSystemMessage(this.state, options.initialSession.modelWarning, "error");
    }
    const layout = {
      redraw: (_state: TuiState) => this.invalidate(),
      resetStatic: () => {
        this.staticTranscriptGeneration += 1;
        this.resetTranscriptViewport();
      },
    };
    this.renderer = new TuiTranscriptRenderer(layout, this.state);
    this.renderer.setApprovalHandler((call, level, description, origin) => this.openApproval(call, level, description, origin));
    this.renderer.setApprovalCancelHandler(() => this.cancelApproval());
  }

  run(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.restoreNativeMouse();
    this.inkInstance = this.renderInk(
      <InkRoot app={this} revision={this.renderRevision} />,
      {
        stdin: this.options.input as NodeJS.ReadStream,
        stdout: this.options.output,
        exitOnCtrlC: false,
      },
    );
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
      this.handleApprovalKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "models") {
      this.handleModelKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "sessions") {
      this.handleSessionKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "session-delete-confirm") {
      void this.handleSessionDeleteConfirmKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "follow-ups") {
      void this.handleFollowUpKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "commands") {
      this.handleCommandKey(input, key);
      return;
    }
    if (this.state.overlay.kind === "files") {
      this.handleFileKey(input, key);
      return;
    }
    if (key.ctrl && input === "q") {
      void this.openFollowUps();
      return;
    }
    if (key.ctrl && input === "o") {
      const reversed = [...this.state.transcript].reverse();
      const target = reversed.find((message) => message.kind === "thought" || message.kind === "tool");
      const latestGroup = toolGroups(this.state.transcript).at(-1);
      if (latestGroup && target?.kind === "tool" && latestGroup.at(-1)?.id === target.id) {
        const groupId = toolGroupId(latestGroup);
        if (this.state.expandedToolGroupIds.has(groupId)) this.state.expandedToolGroupIds.delete(groupId);
        else this.state.expandedToolGroupIds.add(groupId);
        this.staticTranscriptGeneration += 1;
        this.resetTranscriptViewport();
        this.invalidate();
        return;
      }
      if (target && (target.kind === "tool" || target.kind === "thought")) {
        target.expanded = !target.expanded;
        this.invalidate();
      }
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

  async openModels(): Promise<void> {
    if (this.rejectIfBlocked("finish or cancel the current task before switching models")) return;
    try {
      const options = await this.options.loadModels();
      this.modelIndex = 0;
      setOverlay(this.state, { kind: "models", query: "", selectedIndex: 0, options, loading: false });
    } catch (error) {
      setOverlay(this.state, { kind: "models", query: "", selectedIndex: 0, options: [], loading: false, error: errorMessage(error) });
    }
    this.invalidate();
  }

  async openSessions(): Promise<void> {
    if (this.rejectIfBlocked("finish or cancel the current task before switching sessions")) return;
    if (!this.options.loadSessions) return;
    try {
      const options = await this.options.loadSessions();
      this.sessionIndex = 0;
      setOverlay(this.state, { kind: "sessions", query: "", selectedIndex: 0, options });
    } catch (error) {
      this.state.session.status = errorMessage(error);
    }
    this.invalidate();
  }

  private handleComposerKey(input: string, key: Key): void {
    if (isSubmitKey(input, key)) {
      if (key.shift || (key.ctrl && (input === "j" || input === "\n"))) {
        this.detachInputHistory();
        insertText(this.state.composer, "\n");
      }
      else void this.submit();
    } else if (key.ctrl && input === "j") {
      this.detachInputHistory();
      insertText(this.state.composer, "\n");
    } else if (isDeleteBackward(input, key)) {
      this.detachInputHistory();
      deleteBackward(this.state.composer);
    }
    else if (isDeleteForward(input, key)) {
      this.detachInputHistory();
      deleteForward(this.state.composer);
    }
    else if (key.pageUp) this.scrollTranscriptBy(this.pageScrollDelta());
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
    }
    else if (isHomeKey(input, key)) moveToLineEdge(this.state.composer, "start");
    else if (isEndKey(input, key)) moveToLineEdge(this.state.composer, "end");
    else if (key.escape) {
      // Idle Esc clears the draft; busy Esc is handled in handleKey before this.
      this.detachInputHistory();
      setComposerValue(this.state.composer, "");
    }
    else if (input && !key.ctrl && !key.meta) {
      // Multi-char payloads are paste events from Ink; keep newlines intact.
      if (input === "\r" || input === "\n") {
        // bare CR/LF already handled as submit above
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
      void this.options.loadFiles(file.query).then((options) => {
        if (this.state.overlay.kind === "files" && this.state.overlay.query === file.query && this.state.overlay.tokenStart === file.start) {
          this.state.overlay = { ...this.state.overlay, options, loading: false };
          this.invalidate();
        }
      }).catch((error: unknown) => {
        if (this.state.overlay.kind === "files" && this.state.overlay.query === file.query && this.state.overlay.tokenStart === file.start) {
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
      this.commandIndex = Math.min(candidates.length - 1, Math.max(0, previousQuery === value ? previousIndex : 0));
      setOverlay(this.state, {
        kind: "commands",
        query: value,
        selectedIndex: this.commandIndex,
      });
      return;
    }
    if (this.state.overlay.kind === "commands" || this.state.overlay.kind === "files") this.state.overlay = { kind: "none" };
  }

  private handleCommandKey(input: string, key: Key): void {
    const candidates = commandCandidates(composerValue(this.state.composer), this.state.commands);
    if (key.upArrow) {
      this.commandIndex = candidates.length ? (this.commandIndex - 1 + candidates.length) % candidates.length : 0;
      if (this.state.overlay.kind === "commands") this.state.overlay = { ...this.state.overlay, selectedIndex: this.commandIndex };
    }
    else if (key.downArrow) {
      this.commandIndex = candidates.length ? (this.commandIndex + 1) % candidates.length : 0;
      if (this.state.overlay.kind === "commands") this.state.overlay = { ...this.state.overlay, selectedIndex: this.commandIndex };
    }
    else if (key.tab) {
      const command = candidates[this.commandIndex];
      if (command) {
        this.detachInputHistory();
        setComposerValue(this.state.composer, `${command.name} `);
        this.commandIndex = 0;
        this.state.overlay = { kind: "none" };
      } else {
        this.state.overlay = { kind: "none" };
      }
    } else if (isSubmitKey(input, key)) {
      const command = candidates[this.commandIndex];
      this.commandIndex = 0;
      void this.submit(command?.name);
      return;
    } else if (key.escape) {
      this.dismissedCommandInput = composerValue(this.state.composer);
      this.state.overlay = { kind: "none" };
    }
    else {
      this.handleComposerKey(input, key);
      return;
    }
    this.invalidate();
  }

  private handleModelKey(input: string, key: Key): void {
    if (this.state.overlay.kind !== "models") return;
    const options = this.state.overlay.options;
    if (key.upArrow) this.modelIndex = Math.max(0, this.modelIndex - 1);
    else if (key.downArrow) this.modelIndex = Math.min(Math.max(0, options.length - 1), this.modelIndex + 1);
    else if (key.escape) this.state.overlay = { kind: "none" };
    else if (isSubmitKey(input, key)) {
      const selected = options[this.modelIndex];
      if (selected) void this.selectModel(selected);
    }
    this.state.overlay = this.state.overlay.kind === "models"
      ? { ...this.state.overlay, selectedIndex: this.modelIndex }
      : this.state.overlay;
    this.invalidate();
  }

  private handleSessionKey(input: string, key: Key): void {
    if (this.state.overlay.kind !== "sessions") return;
    if (this.selectingSession) return;
    const options = this.state.overlay.options;
    if (key.upArrow) this.sessionIndex = Math.max(0, this.sessionIndex - 1);
    else if (key.downArrow) this.sessionIndex = Math.min(Math.max(0, options.length - 1), this.sessionIndex + 1);
    else if (key.escape) this.state.overlay = { kind: "none" };
    else if (isSessionDeleteKey(input, key)) {
      const selected = options[this.sessionIndex];
      if (selected) this.requestSessionDelete(selected);
    }
    else if (isSubmitKey(input, key)) {
      const selected = options[this.sessionIndex];
      if (selected && this.options.onSessionSelected) void this.selectSession(selected.id);
    }
    this.state.overlay = this.state.overlay.kind === "sessions"
      ? { ...this.state.overlay, selectedIndex: this.sessionIndex }
      : this.state.overlay;
    this.invalidate();
  }

  private handleFileKey(input: string, key: Key): void {
    if (this.state.overlay.kind !== "files") return;
    if (key.upArrow) this.state.overlay = { ...this.state.overlay, selectedIndex: moveSelection(this.state.overlay.selectedIndex, -1, this.state.overlay.options.length) };
    else if (key.downArrow) this.state.overlay = { ...this.state.overlay, selectedIndex: moveSelection(this.state.overlay.selectedIndex, 1, this.state.overlay.options.length) };
    else if (key.tab || isSubmitKey(input, key)) {
      const file = this.state.overlay.options[this.state.overlay.selectedIndex];
      if (file) {
        const value = composerValue(this.state.composer);
        const cursor = composerCursorOffset(this.state.composer);
        const replacement = `@${file}`;
        const next = `${value.slice(0, this.state.overlay.tokenStart)}${replacement}${value.slice(cursor)}`;
        this.detachInputHistory();
        setComposerValue(this.state.composer, `${next} `);
        this.state.overlay = { kind: "none" };
      }
    } else if (key.escape) this.state.overlay = { kind: "none" };
    else {
      this.handleComposerKey(input, key);
      return;
    }
    this.invalidate();
  }

  private requestSessionDelete(selected: SessionOption): void {
    if (this.rejectIfBlocked("finish or cancel the current task before deleting a session")) return;
    if (this.deletingSession || this.state.overlay.kind !== "sessions") return;
    this.state.overlay = {
      kind: "session-delete-confirm",
      sessionId: selected.id,
      sessionName: selected.name,
      selectedIndex: 0,
      returnSelectedIndex: this.sessionIndex,
      options: [...this.state.overlay.options],
    };
    this.invalidate();
  }

  private async handleSessionDeleteConfirmKey(input: string, key: Key): Promise<void> {
    if (this.state.overlay.kind !== "session-delete-confirm" || this.deletingSession) return;
    const overlay = this.state.overlay;
    if (key.leftArrow || key.upArrow) this.state.overlay = { ...overlay, selectedIndex: 0 };
    else if (key.rightArrow || key.downArrow) this.state.overlay = { ...overlay, selectedIndex: 1 };
    else if (key.escape) this.cancelSessionDeleteConfirmation();
    else if (isSessionDeleteKey(input, key) || isSubmitKey(input, key)) {
      if (isSessionDeleteKey(input, key) || overlay.selectedIndex === 0) {
        this.deletingSession = true;
        try {
          const activeSessionId = this.state.session.sessionId;
          const session = await this.options.onSessionDeleted?.(overlay.sessionId);
          if (session) {
            if (session.id !== activeSessionId) this.restoreSession(session);
            this.state.session.status = "session deleted";
            const options = await this.options.loadSessions?.();
            if (options) {
              this.sessionIndex = Math.min(overlay.returnSelectedIndex, Math.max(0, options.length - 1));
              this.state.overlay = {
                kind: "sessions",
                query: "",
                selectedIndex: this.sessionIndex,
                options: [...options],
              };
            } else {
              this.state.overlay = { kind: "none" };
            }
          } else {
            this.state.session.status = "session could not be deleted";
          }
        } catch (error) {
          this.state.session.status = errorMessage(error);
          this.state.overlay = { kind: "sessions", query: "", selectedIndex: overlay.returnSelectedIndex, options: overlay.options };
        } finally {
          this.deletingSession = false;
        }
      } else this.cancelSessionDeleteConfirmation();
    }
    this.invalidate();
  }

  private cancelSessionDeleteConfirmation(): void {
    if (this.state.overlay.kind !== "session-delete-confirm") return;
    const overlay = this.state.overlay;
    this.state.overlay = { kind: "sessions", query: "", selectedIndex: overlay.returnSelectedIndex, options: overlay.options };
    this.sessionIndex = overlay.returnSelectedIndex;
    this.invalidate();
  }

  async openFollowUps(): Promise<void> {
    if (this.followUpBusy) return;
    if (!this.options.loadFollowUps) {
      this.state.session.status = "follow-up queue is unavailable";
      this.invalidate();
      return;
    }
    this.followUpBusy = true;
    try {
      const options = await this.options.loadFollowUps();
      this.state.overlay = { kind: "follow-ups", selectedIndex: 0, options: [...options] };
      this.state.session.status = options.length ? `${options.length} follow-up(s) queued` : "no queued follow-ups";
    } catch (error) {
      this.state.session.status = errorMessage(error);
    } finally {
      this.followUpBusy = false;
    }
    this.invalidate();
  }

  private async handleFollowUpKey(input: string, key: Key): Promise<void> {
    if (this.state.overlay.kind !== "follow-ups" || this.followUpBusy) return;
    const overlay = this.state.overlay;
    if (key.upArrow) this.state.overlay = { ...overlay, selectedIndex: moveSelection(overlay.selectedIndex, -1, overlay.options.length) };
    else if (key.downArrow) this.state.overlay = { ...overlay, selectedIndex: moveSelection(overlay.selectedIndex, 1, overlay.options.length) };
    else if (key.escape) this.state.overlay = { kind: "none" };
    else if (isSubmitKey(input, key)) {
      const selected = overlay.options[overlay.selectedIndex];
      if (selected && this.options.onFollowUpCancelled) {
        this.followUpBusy = true;
        try {
          if (await this.options.onFollowUpCancelled(selected.id)) {
            const options = await this.options.loadFollowUps?.() ?? overlay.options.filter((item) => item.id !== selected.id);
            this.state.overlay = { kind: "follow-ups", selectedIndex: Math.min(overlay.selectedIndex, Math.max(0, options.length - 1)), options: [...options] };
          }
        } catch (error) {
          this.state.session.status = errorMessage(error);
        } finally {
          this.followUpBusy = false;
        }
      }
    }
    this.invalidate();
  }

  private handleApprovalKey(input: string, key: Key): void {
    if (this.state.overlay.kind !== "approval") return;
    const selected = this.state.overlay.selectedIndex;
    const next = key.upArrow ? Math.max(0, selected - 1) : key.downArrow ? Math.min(3, selected + 1) : selected;
    if (key.escape) this.resolveApproval(false);
    else if (isSubmitKey(input, key)) this.resolveApproval(approvalResponse(next));
    else this.state.overlay = { ...this.state.overlay, selectedIndex: next };
    this.invalidate();
  }

  private async selectModel(reference: string): Promise<void> {
    const changed = await this.options.onModelSelected(reference);
    if (changed !== false) this.state.overlay = { kind: "none" };
    this.refreshContext();
  }

  private async selectSession(id: string): Promise<void> {
    if (this.selectingSession) return;
    this.selectingSession = true;
    try {
      const session = await this.options.onSessionSelected?.(id);
      if (session) this.restoreSessionView(session, `Restored session ${session.id}: ${session.name}.`);
      else this.state.overlay = { kind: "none" };
    } finally {
      this.selectingSession = false;
      this.invalidate();
    }
  }

  private async createSession(): Promise<void> {
    if (this.rejectIfBlocked("finish or cancel the current task before creating a session")) return;
    if (!this.options.onSessionCreated) {
      await this.submit("/new");
      return;
    }
    try {
      const session = await this.options.onSessionCreated();
      if (session) {
        this.restoreSession(session);
        this.state.session.status = `started ${session.name}`;
      }
    } catch (error) {
      this.state.session.status = errorMessage(error);
    }
    this.invalidate();
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
    this.state.session.permissionMode = session.permissionMode ?? this.options.getPermissionMode?.() ?? (this.state.session.workMode === "plan" ? "plan" : "default");
    this.state.session.reasoningEffort = session.reasoningEffort ?? this.options.getReasoningEffort?.() ?? this.state.session.reasoningEffort;
    if (session.modelReference) this.state.session.modelReference = { ...session.modelReference };
    else delete this.state.session.modelReference;
    if (session.modelWarning) this.state.session.modelWarning = session.modelWarning;
    else delete this.state.session.modelWarning;
    this.state.transcript = session.messages.map((message) => ({ ...message }));
    this.state.expandedToolGroupIds.clear();
    if (session.modelWarning && !this.state.transcript.some((message) => message.kind === "error" && message.text === session.modelWarning)) {
      appendSystemMessage(this.state, session.modelWarning, "error");
    }
    this.state.composer.history = [...session.history];
    this.state.composer.historyIndex = undefined;
    this.state.composer.historyDraft = "";
    setComposerValue(this.state.composer, "");
    this.state.nextMessageId = nextMessageNumber(this.state.transcript);
    this.state.assistantMessageId = undefined;
    this.state.thoughtMessageId = undefined;
    this.state.streaming = false;
    this.state.activeTaskId = undefined;
    this.state.activeTaskUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.state.lastSequence = 0;
    this.state.processedSequences.clear();
    this.state.session.taskState = "ready";
    this.state.session.status = "";
    this.state.session.currentStep = undefined;
    this.state.session.currentTool = undefined;
    this.state.session.startedAt = undefined;
    this.state.session.elapsedMs = undefined;
    this.state.session.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.state.session.followUpCount = this.options.getFollowUpCount?.() ?? 0;
    this.state.overlay = { kind: "none" };
    this.staticTranscriptGeneration += 1;
    this.resetTranscriptViewport();
    this.invalidate();
    this.refreshContext();
  }

  private async submit(forcedCommand?: string): Promise<void> {
    // Task/approval interactions still accept free-text so session can queue follow-ups.
    // Only block concurrent submits from the composer itself.
    if (this.submitBusy) return;
    const value = (forcedCommand ?? composerValue(this.state.composer)).trim();
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
      this.state.composer.history = [value, ...this.state.composer.history.filter((entry) => entry !== value)].slice(0, 1000);
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

  private openApproval(call: ToolCall, level: number, description: string, origin: SubagentOrigin): Promise<ApprovalResponse> {
    // Replace any previous unresolved approval promise so callers never hang.
    this.cancelApproval();
    this.state.overlay = { kind: "approval", approval: { call, level, description, workspace: this.options.getWorkspace(), origin }, selectedIndex: 0 };
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
    // Runtime callbacks are awaited by the Agent loop. Queueing one root update
    // per event-loop turn gives Ink a render opportunity between streamed deltas
    // while still coalescing bursts that arrive in the same turn.
    queueMicrotask(() => {
      this.renderScheduled = false;
      const revision = this.renderRevision;
      if (this.destroyed || !this.inkInstance) {
        this.resolveRenderWaiters(revision);
        return;
      }
      try {
        this.inkInstance.rerender(<InkRoot app={this} revision={revision} />);
      } catch (error) {
        // Never leave an awaited runtime event blocked behind a failed render.
        // Resolve this revision before allowing Ink's render error to surface.
        this.resolveRenderWaiters(revision);
        throw error;
      }
      // Let Ink's reconciler/stdout writer commit before the awaited provider
      // callback accepts another streamed delta.
      setImmediate(() => this.resolveRenderWaiters(revision));
    });
  }

  async flushPendingRender(ensurePaint = false): Promise<void> {
    const revision = this.renderRevision;
    if (!this.inkInstance || this.destroyed) return;
    if (this.committedRenderRevision < revision) {
      await new Promise<void>((resolve) => {
        this.renderWaiters.push({ revision, resolve });
      });
    }
    if (ensurePaint && !this.destroyed && this.inkInstance) {
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

  syncViewportScroll(
    renderedLines: ReturnType<TranscriptView["linesWithAnchors"]>,
    viewportLines: number,
  ): void {
    const contentLines = renderedLines.length;
    const maximumOffset = Math.max(0, contentLines - Math.max(1, viewportLines));
    const anchor = this.state.transcriptScroll.anchor;
    if (anchor && !this.state.transcriptScroll.followBottom) {
      const anchoredLine = findAnchoredLine(renderedLines, anchor.messageId, anchor.lineOffset);
      if (anchoredLine >= 0) {
        this.state.transcriptScroll.offsetFromBottom = Math.max(0, maximumOffset - anchoredLine);
      }
    }
    syncTranscriptScroll(
      this.state.transcriptScroll,
      contentLines,
      viewportLines,
      this.state.lastTranscriptLines,
    );
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
    const viewportLines = Math.max(
      1,
      this.state.lastTranscriptViewportLines || rows - 6,
    );
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

  transcriptRenderSections(width: number, liveTick = 0): {
    staticItems: StaticTranscriptItem[];
    liveLines: ReturnType<TranscriptView["linesWithAnchors"]>;
  } {
    const lines = this.transcript.linesWithAnchors(this.state, Math.max(12, width), liveTick);
    const firstMutableIndex = this.state.transcript.findIndex((message) =>
      (message.kind === "assistant" && message.streaming)
      || (message.kind === "thought" && message.streaming)
      || (message.kind === "tool" && message.status === "running"),
    );
    let latestExpandableIndex = -1;
    for (let index = this.state.transcript.length - 1; index >= 0; index -= 1) {
      const message = this.state.transcript[index];
      if (message?.kind === "thought" || message?.kind === "tool") {
        latestExpandableIndex = index;
        break;
      }
    }
    const boundaryCandidates = [firstMutableIndex, latestExpandableIndex].filter((index) => index >= 0);
    const staticCount = boundaryCandidates.length > 0
      ? Math.min(...boundaryCandidates)
      : this.state.transcript.length;
    const staticMessages = this.state.transcript.slice(0, staticCount);
    const staticIds = new Set(staticMessages.map((message) => message.id));
    const groupedLines = new Map<string, string[]>();

    for (const line of lines) {
      const messageLines = groupedLines.get(line.messageId) ?? [];
      messageLines.push(line.text);
      groupedLines.set(line.messageId, messageLines);
    }

    return {
      staticItems: staticMessages.flatMap((message) => {
        const messageLines = groupedLines.get(message.id);
        return messageLines?.length
          ? [{ id: message.id, text: messageLines.join("\n") }]
          : [];
      }),
      liveLines: lines.filter((line) => !staticIds.has(line.messageId)),
    };
  }

  staticTranscriptKey(): number {
    return this.staticTranscriptGeneration;
  }

  private pageScrollDelta(): number {
    const rows = Math.max(1, this.options.output.rows || 24);
    const viewportLines = Math.max(
      1,
      this.state.lastTranscriptViewportLines || rows - 6,
    );
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
      this.lastTranscriptRenderLines.length
        - this.state.lastTranscriptViewportLines
        - this.state.transcriptScroll.offsetFromBottom,
    );
    const line = this.lastTranscriptRenderLines[Math.min(top, this.lastTranscriptRenderLines.length - 1)];
    this.state.transcriptScroll.anchor = line
      ? { messageId: line.messageId, lineOffset: line.lineOffset }
      : undefined;
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


function isSubmitKey(input: string, key: Key): boolean {
  // Ink only marks CR as return; some terminals still deliver bare LF on Enter.
  return key.return || input === "\n" || input === "\r";
}

function isSessionDeleteKey(input: string, key: Key): boolean {
  return (key.ctrl && input === "d") || key.delete || key.backspace;
}




function isHomeKey(input: string, key: Key): boolean {
  // Ink Key has no home flag; accept Ctrl+A and common terminal sequences.
  return (key.ctrl && input === "a") || input === "\x1b[H" || input === "\x1b[1~" || input === "\x1bOH";
}

function isEndKey(input: string, key: Key): boolean {
  // Ink Key has no end flag; accept Ctrl+E and common terminal sequences.
  return (key.ctrl && input === "e") || input === "\x1b[F" || input === "\x1b[4~" || input === "\x1bOF";
}

function isDeleteBackward(_input: string, key: Key): boolean {
  // Ink clears `input` for non-alphanumeric keys. On Windows, physical Backspace is
  // usually reported as key.delete (raw DEL 0x7f), so both flags must erase backward.
  return key.backspace || key.delete;
}

function isDeleteForward(input: string, key: Key): boolean {
  // Prefer backward delete for bare Windows Backspace/DEL.
  // Treat explicit forward-delete sequences (often delivered as "\x1b[3~") as forward.
  if (key.backspace) return false;
  if (input === "\x1b[3~" || input === "\x1b[3;1~") return true;
  // Some hosts set delete without backspace for Fn+Backspace / Del.
  return Boolean(key.delete && input.length > 1);
}

function nextMessageNumber(transcript: readonly TranscriptMessage[]): number {
  let maximum = 0;
  for (const message of transcript) {
    const match = /^message-(\d+)$/.exec(message.id);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

function errorMessage(error: unknown): string {
  // Footer/status lines are single-line truncated; keep the headline only there.
  return formatErrorMessage(error);
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

  const width = Math.max(20, (terminalSize.columns || stdout.columns || 80) - 2);
  const rows = Math.max(1, terminalSize.rows || stdout.rows || 24);
  // frame `width` already reserves edge slack; composer text sits after the 2-col prompt.
  const editorWidth = Math.max(1, width - 2);
  const editorLines = visualLines(state.composer, editorWidth);
  const cursor = cursorVisualPosition(state.composer, editorWidth);
  const footer = footerLines(state, width);
  const summary = workSummaryLine(state);
  const workingLine = workingIndicatorLine(state, spinnerTick);
  useEffect(() => {
    if (!busy) return;
    // The same tick animates the fallback Working line and live Thought/Tool rows.
    const timer = setInterval(() => setSpinnerTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [busy]);
  const transcript = app.transcriptRenderSections(width, spinnerTick);
  const transcriptLines = transcript.liveLines;
  const welcomeLines = state.transcript.length === 0 && state.overlay.kind === "none"
    ? oranWelcomeLines(state, width)
    : [];
  const showScrollStatus = state.transcriptScroll.offsetFromBottom > 0;
  const summaryLine = summary;
  const baseChromeLines = 4
    + welcomeLines.length
    + Math.max(0, footer.length - 1)
    + (editorLines.length > 1 ? editorLines.length - 1 : 0)
    + (workingLine ? 1 : 0)
    + (summaryLine ? 1 : 0)
    + (showScrollStatus ? 1 : 0);
  // Reserve one row for the live tail and one for the overlay's bottom margin.
  // Candidate lists are windowed so a short terminal never pushes the composer away.
  const overlayCapacity = Math.max(1, rows - baseChromeLines - 2);
  const commandItemCapacity = Math.max(1, Math.min(7, overlayCapacity - 2));
  const commandLines = state.overlay.kind === "commands"
    ? commandPaletteLines(state.overlay.query, state.overlay.selectedIndex, state.commands, width, commandItemCapacity)
    : [];
  const overlayLines = fitOverlayLines(
    renderOverlayLines(state, commandLines, width),
    overlayCapacity,
  );
  // Keep the mutable frame below the terminal height so Ink never enters its
  // clearTerminal paint path. The completed form is emitted to Static in full.
  const viewportLines = Math.max(
    1,
    rows
      - baseChromeLines
      - (overlayLines.length > 0 ? overlayLines.length + 1 : 0)
      - 1,
  );
  app.syncViewportScroll(transcriptLines, viewportLines);
  const maximumStart = Math.max(0, transcriptLines.length - viewportLines);
  const viewportStart = Math.max(
    0,
    maximumStart - Math.min(maximumStart, state.transcriptScroll.offsetFromBottom),
  );
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
  const frameHeight = visibleTranscriptLines.length
    + baseChromeLines
    + (overlayLines.length > 0 ? overlayLines.length + 1 : 0)
    + (visibleTranscriptLines.length === 0 && overlayLines.length === 0 ? 1 : 0);
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
  }, [app, parkUp, parkColumn, visibleTranscriptLines.length, overlayLines.length, workingLine, summaryLine, busy, state.overlay.kind, editorLines.length, footer.length]);

  return (
    <Box flexDirection="column" width="100%">
      <Static
        key={`${state.session.sessionId}:${app.staticTranscriptKey()}`}
        items={transcript.staticItems}
      >
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
        {scrollStatusLine ? <Text color={COLORS.accentDim}>{scrollStatusLine}</Text> : null}
        {workingLine ? <Text color={COLORS.activity}>{workingLine}</Text> : null}
        {summaryLine ? <Text color={COLORS.success}>{summaryLine}</Text> : null}
        <Text dimColor>{horizontalRule(width)}</Text>
        <Text>
          <Text color={COLORS.accent} bold>{composerPrefix(state.overlay.kind).trimEnd()}</Text>
          <Text>{composerPrefix(state.overlay.kind).endsWith(" ") ? " " : ""}{renderComposerLines(editorLines, cursor.row, cursor.column)}</Text>
          {ghostCommandSuggestion(state, composerValue(state.composer)) ? <Text dimColor>{ghostCommandSuggestion(state, composerValue(state.composer))}</Text> : null}
        </Text>
        <Text dimColor>{horizontalRule(width)}</Text>
        {footer.map((line, index) => (
          index === 0
            ? <Text key={`footer-${index}`} color={COLORS.accentDim}>{line}</Text>
            : <Text key={`footer-${index}`} dimColor>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}

function oranWelcomeLines(state: TuiState, availableWidth: number): string[] {
  const model = welcomeModelLabel(state);
  const labelWidth = 11;
  const modelLine = `${"model:".padEnd(labelWidth)}${model}`;
  const directoryLine = `${"directory:".padEnd(labelWidth)}${state.session.workspace}`;
  const preferredWidth = Math.max(
    48,
    visibleWidth(">_ Oran code") + 4,
    visibleWidth(modelLine) + 4,
    visibleWidth(directoryLine) + 4,
  );
  const cardWidth = Math.max(20, Math.min(72, availableWidth, preferredWidth));
  const contentWidth = Math.max(1, cardWidth - 4);
  const valueWidth = Math.max(1, contentWidth - labelWidth);
  const content = [
    `${ANSI.orangeBold}>_ Oran code${ANSI.reset}`,
    "",
    `${ANSI.bold}${"model:".padEnd(labelWidth)}${ANSI.reset}${truncateVisible(model, valueWidth)}`,
    `${ANSI.bold}${"directory:".padEnd(labelWidth)}${ANSI.reset}${truncateVisible(state.session.workspace, valueWidth)}`,
  ];
  const top = `${ANSI.gray}╭${"─".repeat(cardWidth - 2)}╮${ANSI.reset}`;
  const bottom = `${ANSI.gray}╰${"─".repeat(cardWidth - 2)}╯${ANSI.reset}`;
  const rows = content.map((line) => {
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return `${ANSI.gray}│${ANSI.reset} ${line}${padding} ${ANSI.gray}│${ANSI.reset}`;
  });
  return [top, ...rows, bottom];
}

function welcomeModelLabel(state: TuiState): string {
  const fullLabel = state.session.modelLabel || "(not selected)";
  if (fullLabel.startsWith("(")) return fullLabel;
  const separator = fullLabel.indexOf("/");
  const model = separator >= 0 ? fullLabel.slice(separator + 1) : fullLabel;
  return `${model} ${state.session.reasoningEffort}`;
}

function ghostCommandSuggestion(state: TuiState, input: string): string {
  if (state.overlay.kind !== "commands" || !input.startsWith("/") || /\s/.test(input)) return "";
  const candidate = commandCandidates(input, state.commands)[0];
  if (!candidate || !candidate.name.startsWith(input) || candidate.name === input) return "";
  return candidate.name.slice(input.length);
}

function renderOverlayLines(state: TuiState, commandLines: string[], width: number): string[] {
  switch (state.overlay.kind) {
    case "models":
      return [horizontalRule(width), "Select model", horizontalRule(width), ...modelSelectorLines(state.overlay.options, state.overlay.selectedIndex)];
    case "approval":
      return approvalDialogLines(
        state.overlay.approval.call,
        state.overlay.approval.level,
        state.overlay.approval.description,
        state.overlay.approval.workspace,
        state.overlay.approval.origin,
        state.overlay.selectedIndex,
        width,
      );
    case "sessions":
      {
        const overlay = state.overlay;
        return [
          horizontalRule(width),
          currentSessionLine(overlay.options, width),
          "Enter Resume   Del Remove   Esc Close",
          "",
          ...overlay.options.map((item, index) => highlightSelection(
            `  ${sessionOptionLabel(item, Math.max(1, width - 2))}`,
            index === overlay.selectedIndex,
          )),
        ];
      }
    case "session-delete-confirm":
      {
        const overlay = state.overlay;
      return [
        horizontalRule(width),
        "Delete session?",
        `  ${truncateVisible(overlay.sessionName, Math.max(1, width - 2))}`,
        "Enter/Del Confirm   Esc Cancel",
        "",
        highlightSelection("  Delete", overlay.selectedIndex === 0),
        highlightSelection("  Cancel", overlay.selectedIndex === 1),
      ];
      }
    case "follow-ups":
      {
        const overlay = state.overlay;
      return [
        horizontalRule(width),
        "Follow-ups",
        "Enter Cancel selected   Esc Close",
        "",
        ...(overlay.options.length
          ? overlay.options.map((item, index) => highlightSelection(`  ${item.id}  ${truncateVisible(item.prompt.replace(/\s+/g, " ").trim(), Math.max(1, width - 2))}`, index === overlay.selectedIndex))
          : ["  (no queued follow-ups)"]),
      ];
      }
    case "files":
      {
        const overlay = state.overlay;
      return [
        horizontalRule(width),
        `@${overlay.query}`,
        "Enter Insert   Esc Close",
        "",
        ...(overlay.loading && !overlay.options.length
          ? ["  loading..."]
          : overlay.options.length
            ? overlay.options.map((item, index) => highlightSelection(`  ${truncateVisible(item, Math.max(1, width - 2))}`, index === overlay.selectedIndex))
            : ["  (no matching files)"]),
      ];
      }
    case "commands":
      return commandLines;
    default:
      return [];
  }
}

function fitOverlayLines(lines: readonly string[], capacity: number): string[] {
  const height = Math.max(1, Math.floor(capacity));
  if (lines.length <= height) return [...lines];
  const activeLine = lines.findIndex((line) => line.includes("{inverse}"));
  if (activeLine >= 0 && height === 1) return [lines[activeLine]!];
  if (activeLine >= 0 && height === 2) return [lines[0]!, lines[activeLine]!];
  if (height === 1) return [lines[lines.length - 1]!];
  if (height === 2) return [lines[0]!, lines[lines.length - 1]!];

  // Preserve the overlay identity/help while keeping the active option visible.
  const headerHeight = Math.min(2, height - 1);
  const header = lines.slice(0, headerHeight);
  const body = lines.slice(headerHeight);
  const selectedLine = Math.max(0, body.findIndex((line) => line.includes("{inverse}")));
  const bodyHeight = height - header.length;
  const start = Math.max(0, Math.min(selectedLine - bodyHeight + 1, body.length - bodyHeight));
  return [...header, ...body.slice(start, start + bodyHeight)];
}

function fileQuery(value: string, cursor: number): { query: string; start: number } | undefined {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return undefined;
  return { query: match[1] ?? "", start: before.lastIndexOf("@") };
}

function HighlightedLine({ value }: { value: string }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  const pattern = /\{inverse\}([\s\S]*?)\{\/inverse\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t-${key++}`}>{value.slice(lastIndex, match.index)}</Text>);
    }
    parts.push(<Text key={`s-${key++}`} inverse>{match[1]}</Text>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) parts.push(<Text key={`t-${key++}`}>{value.slice(lastIndex)}</Text>);
  if (!parts.length) return <Text> </Text>;
  return <Text>{parts}</Text>;
}

function composerPrefix(kind: TuiState["overlay"]["kind"]): string {
  // Keep the exclusive-overlay bang only for modal overlays that own the input.
  // Commands/files still edit the free-form composer and should keep the prompt.
  return kind === "none" || kind === "commands" || kind === "files" ? "> " : "! ";
}

function renderComposerLines(
  editorLines: ReturnType<typeof visualLines>,
  cursorRow: number,
  cursorColumn: number,
): React.JSX.Element {
  // Real terminal cursor is also parked for IME; draw an inverse cell so the caret
  // stays visibly glued to the input box even if the host cursor briefly drifts.
  const lines = editorLines.length ? editorLines : [{ text: "", logicalLine: 0, startColumn: 0 }];
  const safeRow = Math.max(0, Math.min(lines.length - 1, cursorRow));
  return (
    <Text>
      {lines.map((line, index) => {
        const prefix = index === 0 ? "" : "\n  ";
        if (index !== safeRow) {
          return <Text key={`composer-line-${index}`}>{prefix}{line.text || " "}</Text>;
        }
        return <Text key={`composer-line-${index}`}>{prefix}{renderComposerLineWithCaret(line.text, cursorColumn)}</Text>;
      })}
    </Text>
  );
}

function renderComposerLineWithCaret(text: string, cursorColumn: number): React.JSX.Element {
  const symbols = graphemes(text);
  // cursorColumn is display-width based; walk cells to the caret boundary.
  let display = 0;
  let splitAt = 0;
  while (splitAt < symbols.length) {
    const symbol = symbols[splitAt] ?? "";
    const width = Math.max(1, visibleWidth(symbol));
    if (display + width > cursorColumn) break;
    display += width;
    splitAt += 1;
  }
  const before = symbols.slice(0, splitAt).join("");
  const active = symbols[splitAt];
  const after = symbols.slice(splitAt + (active === undefined ? 0 : 1)).join("");
  // Wide glyphs (CJK/emoji) keep a single inverse cell so the caret does not
  // jump ahead of the logical insertion point.
  return (
    <Text>
      {before}
      <Text inverse>{active ?? " "}</Text>
      {after}
    </Text>
  );
}
