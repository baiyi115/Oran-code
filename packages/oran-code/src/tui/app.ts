import blessed from "blessed";
import type { Widgets } from "blessed";
import type { Readable, Writable } from "node:stream";
import type { ApprovalResponse, ModelReference, ToolCall } from "../types.js";
import { REASONING_EFFORTS, type PermissionMode, type ReasoningEffort, type WorkMode } from "../types.js";
import { commandCandidates } from "./command-palette.js";
import { approvalResponse, moveSelection, navigateHistory } from "./interaction.js";
import { createTuiLayout, type TuiLayout } from "./layout.js";
import { TuiTranscriptRenderer } from "./renderer.js";
import type { FollowUpOption, SessionOption, SessionView, TuiState } from "./types.js";
import { composerValue, createTuiState, setComposerValue } from "./state.js";
import { cursorVisualPosition, deleteBackward, deleteForward, insertText, moveCursor, moveToLineEdge, setComposerCursorOffset, visualLines } from "./composer.js";
import { KEYBINDINGS, matchesAnyKey, matchesKey } from "./keybindings.js";
import { appendSystemMessage } from "./message-reducer.js";
import { isSessionBusy } from "./status-indicator.js";
import { formatErrorMessage } from "../error-format.js";
import type { SlashCommand } from "../commands.js";

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

export interface TuiAppDependencies {
  createScreen: typeof blessed.screen;
  createLayout: typeof createTuiLayout;
}

export class TuiApp {
  readonly renderer: TuiTranscriptRenderer;
  private readonly screen: Widgets.Screen;
  private readonly layout: TuiLayout;
  private readonly state: TuiState;
  private readonly options: TuiAppOptions;
  private resolveRun: (() => void) | undefined;
  private approvalResolve: ((response: ApprovalResponse) => void) | undefined;
  private destroyed = false;
  private lastCancelAt = 0;
  private deletingSession = false;
  private lastModelOptions: string[] = [];
  private submitBusy = false;
  private busyOperation: "models" | "sessions" | "session" | "model" | "follow-ups" | "settings" | undefined;
  private operationGeneration = 0;
  private overlayGeneration = 0;
  private dismissedCommandInput: string | undefined;

  constructor(options: TuiAppOptions, dependencies: Partial<TuiAppDependencies> = {}) {
    this.options = options;
    const createScreen = dependencies.createScreen ?? blessed.screen;
    const cursor = {
      artificial: false,
    } as unknown as Widgets.Types.TCursor;
    this.screen = createScreen({
      // blessed's bundled declarations reverse the stream roles. Keep the
      // runtime direction correct: stdin is readable and stdout is writable.
      input: options.input as unknown as Writable,
      output: options.output as unknown as Readable,
      fullUnicode: true,
      warnings: false,
      useBCE: true,
      mouse: true,
      // Keep the cursor shape owned by the host terminal. Blessed's artificial
      // cursor stays disabled because it redraws the screen every 500ms.
      cursor,
    });
    this.layout = (dependencies.createLayout ?? createTuiLayout)(this.screen);
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
    if (options.initialSession?.modelWarning && !this.state.transcript.some((message) => message.kind === "error" && message.text === options.initialSession?.modelWarning)) {
      appendSystemMessage(this.state, options.initialSession.modelWarning, "error");
    }
    this.renderer = new TuiTranscriptRenderer(this.layout, this.state);
    this.renderer.setApprovalHandler((call, level, description) => this.openApproval(call, level, description));
    this.renderer.setApprovalCancelHandler(() => this.cancelApproval());
    this.screen.on("keypress", (ch, key) => this.handleKey(ch, key));
    this.screen.on("mouse", (event: unknown) => this.handleMouse(event));
    this.screen.on("paste", (value: string) => {
      if (this.state.overlay.kind !== "none") return;
      insertText(this.state.composer, value);
      this.updateInputOverlay();
      this.redraw();
    });
    this.screen.on("resize", () => this.redraw());
    this.redraw();
  }

  run(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      this.redraw();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.overlayGeneration += 1;
    this.operationGeneration += 1;
    this.busyOperation = undefined;
    this.cancelApproval();
    this.resolveRun?.();
    this.resolveRun = undefined;
    this.layout.destroy();
  }

  refreshContext(): void {
    this.state.session.workspace = this.options.getWorkspace();
    this.state.session.modelLabel = this.options.getModelLabel();
    const modelReference = this.options.getModelReference?.();
    if (modelReference) this.state.session.modelReference = { ...modelReference };
    else delete this.state.session.modelReference;
    const modelWarning = this.options.getModelWarning?.();
    if (modelWarning) this.state.session.modelWarning = modelWarning;
    else delete this.state.session.modelWarning;
    this.state.session.sessionName = this.options.getSessionName?.() ?? this.state.session.sessionName;
    this.state.session.approvalPolicy = this.options.getApprovalPolicy?.() ?? this.state.session.approvalPolicy;
    this.state.session.workMode = this.options.getWorkMode?.() ?? this.state.session.workMode;
    this.state.session.permissionMode = this.options.getPermissionMode?.() ?? this.state.session.permissionMode;
    this.state.session.reasoningEffort = this.options.getReasoningEffort?.() ?? this.state.session.reasoningEffort;
    const contextWindow = this.options.getContextWindow?.();
    if (contextWindow === undefined) delete this.state.session.contextWindow;
    else this.state.session.contextWindow = contextWindow;
    this.state.session.followUpCount = this.options.getFollowUpCount?.() ?? this.state.session.followUpCount;
    this.state.commands = [...(this.options.getCommands?.() ?? this.state.commands)];
    this.redraw();
  }

  history(): readonly string[] {
    return this.state.composer.history;
  }

  sessionSnapshot(): SessionView {
    return this.sessionView();
  }

  private handleKey(ch: string, key: Widgets.Events.IKeyEventArg): void {
    if (this.destroyed) return;
    this.syncOverlayFocus();
    if (this.state.overlay.kind === "none" && matchesKey(key, KEYBINDINGS.switchReasoningEffort)) {
      if (!this.busyOperation) void this.toggleReasoningEffort();
      else this.showBusyStatus();
      return;
    }
    if (this.state.overlay.kind === "none" && matchesKey(key, KEYBINDINGS.switchPermissionMode)) {
      if (!this.busyOperation) void this.toggleWorkMode();
      else this.showBusyStatus();
      return;
    }
    // Esc cancels the active agent turn (Agent Loop F7) when no overlay owns it.
    if (matchesKey(key, KEYBINDINGS.closeOverlay) && this.state.overlay.kind === "none" && (this.options.isInteractionBlocked?.() || isSessionBusy(this.state))) {
      this.options.onCancel();
      if (!this.state.session.status) this.state.session.status = "cancelling...";
      this.redraw();
      return;
    }
    if (matchesKey(key, KEYBINDINGS.cancel)) {
      if (this.state.overlay.kind !== "none") {
        if (this.state.overlay.kind === "approval") this.resolveApproval(false);
        else if (this.state.overlay.kind === "session-delete-confirm" && !this.deletingSession && !this.busyOperation) this.cancelSessionDeleteConfirmation();
        else this.closeOverlay();
        return;
      }
      if (this.busyOperation) {
        if (this.busyOperation === "session" || this.busyOperation === "model" || this.busyOperation === "settings") {
          this.showBusyStatus();
          return;
        }
        const operation = this.busyOperation;
        this.cancelOverlayOperation();
        this.state.session.status = `${operation} operation cancelled`;
        this.redraw();
        return;
      }
      const handled = this.options.onCancel();
      if (!handled) {
        const now = Date.now();
        if (now - this.lastCancelAt < 1200) this.finish();
        else this.state.session.status = "press Ctrl+C again to exit";
        this.lastCancelAt = now;
        this.redraw();
      }
      return;
    }
    if (this.state.overlay.kind === "none" && this.busyOperation) {
      this.showBusyStatus();
      return;
    }
    if (this.state.overlay.kind === "approval") {
      this.handleApprovalKey(ch, key);
      return;
    }
    if (this.state.overlay.kind === "models") {
      this.handleModelKey(key);
      return;
    }
    if (this.state.overlay.kind === "sessions") {
      this.handleSessionKey(key);
      return;
    }
    if (this.state.overlay.kind === "session-delete-confirm") {
      void this.handleSessionDeleteConfirmKey(key);
      return;
    }
    if (this.state.overlay.kind === "follow-ups") {
      void this.handleFollowUpKey(key);
      return;
    }
    if (this.state.overlay.kind === "files") {
      this.handleFileKey(ch, key);
      return;
    }
    if (this.state.overlay.kind === "commands") {
      this.handleCommandKey(ch, key);
      return;
    }
    this.handleInputKey(ch, key);
  }

  private handleInputKey(ch: string, key: Widgets.Events.IKeyEventArg): void {
    if (this.submitBusy) return;
    if (this.busyOperation) {
      this.showBusyStatus();
      return;
    }
    if (matchesKey(key, KEYBINDINGS.toggleTool)) {
      this.toggleLatestDetail();
      return;
    }
    if (matchesKey(key, KEYBINDINGS.followUpQueue)) {
      void this.openFollowUps();
      return;
    }
    if (matchesKey(key, KEYBINDINGS.submit)) {
      if (key.shift) insertText(this.state.composer, "\n");
      else void this.submit();
      return;
    }
    if (matchesKey(key, KEYBINDINGS.deleteBackward)) {
      deleteBackward(this.state.composer);
    } else if (matchesKey(key, KEYBINDINGS.deleteForward)) {
      deleteForward(this.state.composer);
    } else if (matchesKey(key, KEYBINDINGS.moveLeft)) {
      moveCursor(this.state.composer, "left");
    } else if (matchesKey(key, KEYBINDINGS.moveRight)) {
      moveCursor(this.state.composer, "right");
    } else if (matchesKey(key, KEYBINDINGS.moveToStart)) {
      moveToLineEdge(this.state.composer, "start");
    } else if (matchesKey(key, KEYBINDINGS.moveToEnd)) {
      moveToLineEdge(this.state.composer, "end");
    } else if (matchesKey(key, KEYBINDINGS.moveUp)) {
      if (this.canMoveComposerVertically("up")) moveCursor(this.state.composer, "up", this.editorWidth());
      else this.navigateInputHistory("older");
    } else if (matchesKey(key, KEYBINDINGS.moveDown)) {
      if (this.canMoveComposerVertically("down")) moveCursor(this.state.composer, "down", this.editorWidth());
      else this.navigateInputHistory("newer");
    } else if (matchesAnyKey(key, KEYBINDINGS.insertNewline)) {
      insertText(this.state.composer, "\n");
    } else if (matchesKey(key, KEYBINDINGS.closeOverlay)) {
      this.setInput("", 0);
    } else {
      this.insertPrintable(ch, key);
    }
    this.updateInputOverlay();
    this.redraw();
  }

  private handleCommandKey(ch: string, key: Widgets.Events.IKeyEventArg): void {
    if (this.busyOperation) {
      if (matchesKey(key, KEYBINDINGS.closeOverlay)) this.closeOverlay();
      else this.showBusyStatus();
      return;
    }
    const candidates = commandCandidates(composerValue(this.state.composer), this.state.commands);
    const selectedIndex = this.state.overlay.kind === "commands" ? this.state.overlay.selectedIndex : 0;
    if (matchesKey(key, KEYBINDINGS.moveUp)) {
      this.setCommandSelection(moveSelection(selectedIndex, -1, candidates.length));
    } else if (matchesKey(key, KEYBINDINGS.moveDown)) {
      this.setCommandSelection(moveSelection(selectedIndex, 1, candidates.length));
    } else if (matchesKey(key, KEYBINDINGS.submit)) {
      const selected = candidates[selectedIndex];
      if (selected) {
        const value = `${selected.name} `;
        this.setInput(value, value.length);
        this.dismissOverlay();
        this.redraw();
        return;
      }
      void this.submit();
      return;
    } else if (matchesKey(key, KEYBINDINGS.switchOverlaySelectionForward)) {
      const selected = candidates[selectedIndex];
      if (selected) {
        const value = `${selected.name} `;
        this.setInput(value, value.length);
        this.closeOverlay();
        this.updateInputOverlay();
      } else this.closeOverlay();
      return;
    } else if (matchesKey(key, KEYBINDINGS.closeOverlay)) {
      this.dismissedCommandInput = composerValue(this.state.composer);
      this.dismissOverlay();
      this.redraw();
      return;
    } else {
      this.handleInputKey(ch, key);
      return;
    }
    this.redraw();
  }

  private handleModelKey(key: Widgets.Events.IKeyEventArg): void {
    if (this.state.overlay.kind !== "models") return;
    if (this.busyOperation) {
      if (matchesKey(key, KEYBINDINGS.closeOverlay)) this.closeOverlay();
      else this.showBusyStatus();
      return;
    }
    const selectedIndex = this.state.overlay.selectedIndex;
    if (matchesKey(key, KEYBINDINGS.moveUp)) this.setModelSelection(moveSelection(selectedIndex, -1, this.state.overlay.options.length));
    else if (matchesKey(key, KEYBINDINGS.moveDown)) this.setModelSelection(moveSelection(selectedIndex, 1, this.state.overlay.options.length));
    else if (matchesKey(key, KEYBINDINGS.closeOverlay)) this.closeOverlay();
    else if (matchesKey(key, KEYBINDINGS.submit)) {
      const selected = this.state.overlay.options[selectedIndex];
      if (selected) void this.selectModel(selected);
    }
    this.redraw();
  }

  private handleSessionKey(key: Widgets.Events.IKeyEventArg): void {
    if (this.state.overlay.kind !== "sessions") return;
    if (this.busyOperation && !matchesKey(key, KEYBINDINGS.closeOverlay)) return;
    const options = this.state.overlay.options;
    if (matchesKey(key, KEYBINDINGS.moveUp)) {
      this.setSessionSelection(moveSelection(this.state.overlay.selectedIndex, -1, options.length));
    } else if (matchesKey(key, KEYBINDINGS.moveDown)) {
      this.setSessionSelection(moveSelection(this.state.overlay.selectedIndex, 1, options.length));
    } else if (matchesKey(key, KEYBINDINGS.closeOverlay)) {
      this.closeOverlay();
    } else if (matchesAnyKey(key, [KEYBINDINGS.deleteSession, "delete", "backspace"])) {
      const selected = options[this.state.overlay.selectedIndex];
      if (selected) this.requestSessionDelete(selected);
    } else if (matchesKey(key, KEYBINDINGS.submit)) {
      const selected = options[this.state.overlay.selectedIndex];
      if (selected) void this.selectSession(selected.id);
    }
    this.redraw();
  }

  private requestSessionDelete(selected: SessionOption): void {
    if (this.isInteractionBlocked("finish or cancel the current task before deleting a session")) return;
    if (this.deletingSession) return;
    const sessions = this.state.overlay;
    if (sessions.kind !== "sessions") return;
    this.state.overlay = {
      kind: "session-delete-confirm",
      sessionId: selected.id,
      sessionName: selected.name,
      selectedIndex: 0,
      returnSelectedIndex: sessions.selectedIndex,
      options: [...sessions.options],
    };
    this.redraw();
  }

  private async handleSessionDeleteConfirmKey(key: Widgets.Events.IKeyEventArg): Promise<void> {
    if (this.state.overlay.kind !== "session-delete-confirm" || this.deletingSession || this.busyOperation) return;
    const overlay = this.state.overlay;
    if (key.name === "left" || matchesKey(key, KEYBINDINGS.moveUp)) this.state.overlay = { ...overlay, selectedIndex: 0 };
    else if (key.name === "right" || matchesKey(key, KEYBINDINGS.moveDown)) this.state.overlay = { ...overlay, selectedIndex: 1 };
    else if (matchesKey(key, KEYBINDINGS.closeOverlay)) {
      this.cancelSessionDeleteConfirmation();
    } else if (matchesAnyKey(key, [KEYBINDINGS.deleteSession, "delete", "backspace"]) || matchesKey(key, KEYBINDINGS.submit)) {
      if (matchesAnyKey(key, [KEYBINDINGS.deleteSession, "delete", "backspace"]) || overlay.selectedIndex === 0) {
        this.deletingSession = true;
        try {
          await this.deleteSession(overlay.sessionId);
        } finally {
          this.deletingSession = false;
        }
      } else {
        this.cancelSessionDeleteConfirmation();
      }
    }
    this.redraw();
  }

  private cancelSessionDeleteConfirmation(): void {
    if (this.state.overlay.kind !== "session-delete-confirm") return;
    const overlay = this.state.overlay;
    this.state.overlay = { kind: "sessions", query: "", selectedIndex: overlay.returnSelectedIndex, options: overlay.options };
    this.deletingSession = false;
    this.redraw();
  }

  private async handleFollowUpKey(key: Widgets.Events.IKeyEventArg): Promise<void> {
    if (this.state.overlay.kind !== "follow-ups") return;
    if (this.busyOperation && !matchesKey(key, KEYBINDINGS.closeOverlay)) return;
    const overlay = this.state.overlay;
    if (matchesKey(key, KEYBINDINGS.moveUp)) {
      this.state.overlay = { ...overlay, selectedIndex: moveSelection(overlay.selectedIndex, -1, overlay.options.length) };
    } else if (matchesKey(key, KEYBINDINGS.moveDown)) {
      this.state.overlay = { ...overlay, selectedIndex: moveSelection(overlay.selectedIndex, 1, overlay.options.length) };
    } else if (matchesKey(key, KEYBINDINGS.closeOverlay)) {
      this.closeOverlay();
    } else if (matchesKey(key, KEYBINDINGS.submit)) {
      const selected = overlay.options[overlay.selectedIndex];
      if (selected && this.options.onFollowUpCancelled) {
        const token = this.beginOperation("follow-ups");
        if (token === undefined) return;
        const overlayToken = this.overlayGeneration;
        try {
          const cancelled = await this.options.onFollowUpCancelled(selected.id);
          if (this.isCurrentOperation("follow-ups", token) && this.overlayGeneration === overlayToken && this.state.overlay.kind === "follow-ups" && cancelled) {
            const options = await this.options.loadFollowUps?.() ?? overlay.options.filter((item) => item.id !== selected.id);
            if (this.isCurrentOperation("follow-ups", token) && this.overlayGeneration === overlayToken && this.state.overlay.kind === "follow-ups") {
              this.state.overlay = { kind: "follow-ups", selectedIndex: Math.min(overlay.selectedIndex, Math.max(0, options.length - 1)), options };
            }
          }
        } catch (error) {
          if (this.isCurrentOperation("follow-ups", token)) this.state.session.status = formatErrorMessage(error);
        } finally {
          this.finishOperation("follow-ups", token);
        }
      }
    }
    this.redraw();
  }

  private handleFileKey(ch: string, key: Widgets.Events.IKeyEventArg): void {
    if (this.state.overlay.kind !== "files") return;
    const options = this.state.overlay.options;
    if (matchesKey(key, KEYBINDINGS.moveUp)) this.state.overlay = { ...this.state.overlay, selectedIndex: moveSelection(this.state.overlay.selectedIndex, -1, options.length) };
    else if (matchesKey(key, KEYBINDINGS.moveDown)) this.state.overlay = { ...this.state.overlay, selectedIndex: moveSelection(this.state.overlay.selectedIndex, 1, options.length) };
    else if (matchesKey(key, KEYBINDINGS.closeOverlay)) this.closeOverlay();
    else if (matchesKey(key, KEYBINDINGS.submit) || matchesKey(key, KEYBINDINGS.switchOverlaySelectionForward)) {
      const selected = options[this.state.overlay.selectedIndex];
      if (selected) this.insertFileSelection(selected);
    } else {
      this.handleInputKey(ch, key);
      return;
    }
    this.redraw();
  }

  private handleApprovalKey(ch: string, key: Widgets.Events.IKeyEventArg): void {
    if (this.state.overlay.kind !== "approval") return;
    const selectedIndex = this.state.overlay.selectedIndex;
    if (matchesKey(key, KEYBINDINGS.moveUp)) this.setApprovalSelection(moveSelection(selectedIndex, -1, 3));
    else if (matchesKey(key, KEYBINDINGS.moveDown)) this.setApprovalSelection(moveSelection(selectedIndex, 1, 3));
    else if (matchesKey(key, KEYBINDINGS.closeOverlay)) this.resolveApproval(false);
    else if (matchesKey(key, KEYBINDINGS.submit)) this.resolveApproval(approvalResponse(selectedIndex));
    this.redraw();
  }

  private async submit(): Promise<void> {
    if (this.submitBusy) return;
    const value = composerValue(this.state.composer).trim();
    if (!value) return;
    this.submitBusy = true;
    this.setInput("", 0);
    this.state.composer.historyIndex = undefined;
    this.state.composer.historyDraft = "";
    this.closeOverlay();
    this.redraw();
    let accepted = false;
    try {
      await this.options.onInput(value);
      accepted = true;
      this.recordHistory(value);
      await this.options.onSessionChanged?.(this.sessionView());
      this.refreshContext();
    } catch (error) {
      if (!accepted) this.setInput(value, value.length);
      this.renderer.error(formatErrorMessage(error));
    } finally {
      this.submitBusy = false;
      this.redraw();
    }
  }

  private insertPrintable(ch: string, key: Widgets.Events.IKeyEventArg): void {
    if (isPrintable(ch, key)) insertText(this.state.composer, ch);
  }

  private async toggleWorkMode(): Promise<void> {
    const token = this.beginOperation("settings");
    if (token === undefined) return this.showBusyStatus();
    const current = this.options.getWorkMode?.() ?? this.state.session.workMode;
    const next: WorkMode = current === "plan" ? "auto" : "plan";
    try {
      const changed = await this.options.onWorkModeChanged?.(next);
      if (!this.isCurrentOperation("settings", token)) return;
      if (changed === false) {
        this.state.session.status = "finish or cancel the current task before switching mode";
      } else {
        this.state.session.workMode = next;
        if (next === "plan") this.state.session.permissionMode = "plan";
        else if (this.state.session.permissionMode === "plan") this.state.session.permissionMode = "default";
        this.state.session.status = next;
        await this.options.onSessionChanged?.(this.sessionView());
      }
    } catch (error) {
      if (this.isCurrentOperation("settings", token)) this.renderer.error(formatErrorMessage(error));
    } finally {
      this.finishOperation("settings", token);
    }
    this.redraw();
  }

  private async toggleReasoningEffort(): Promise<void> {
    const token = this.beginOperation("settings");
    if (token === undefined) return this.showBusyStatus();
    const currentIndex = REASONING_EFFORTS.indexOf(this.state.session.reasoningEffort);
    const next = REASONING_EFFORTS[(currentIndex + 1) % REASONING_EFFORTS.length] ?? "medium";
    try {
      const changed = await this.options.onReasoningEffortChanged?.(next);
      if (!this.isCurrentOperation("settings", token)) return;
      if (changed === false) {
        this.state.session.status = "finish or cancel the current task before changing thinking strength";
      } else {
        this.state.session.reasoningEffort = next;
        this.state.session.status = next;
        await this.options.onSessionChanged?.(this.sessionView());
      }
    } catch (error) {
      if (this.isCurrentOperation("settings", token)) this.renderer.error(formatErrorMessage(error));
    } finally {
      this.finishOperation("settings", token);
    }
    this.redraw();
  }

  async openModels(): Promise<void> {
    if (this.isInteractionBlocked("finish or cancel the current task before changing the model")) return;
    if (this.busyOperation) return this.showBusyStatus();
    const token = this.beginOperation("models");
    if (token === undefined) return;
    const overlayToken = ++this.overlayGeneration;
    const currentLabel = this.options.getModelReference ? `${this.options.getModelReference()?.provider ?? ""}/${this.options.getModelReference()?.model ?? ""}` : this.options.getModelLabel();
    const currentIndex = this.lastModelOptions.indexOf(currentLabel);
    this.state.overlay = {
      kind: "models",
      query: "",
      selectedIndex: currentIndex >= 0 ? currentIndex : 0,
      options: [...this.lastModelOptions],
      loading: true,
    };
    this.setInput("", 0);
    this.state.session.status = "loading models...";
    this.redraw();
    try {
      const options = await this.options.loadModels();
      if (this.isCurrentOperation("models", token) && this.overlayGeneration === overlayToken && this.state.overlay.kind === "models") {
        this.lastModelOptions = [...options];
        const selectedIndex = Math.min(this.state.overlay.selectedIndex, Math.max(0, options.length - 1));
        this.state.overlay = { ...this.state.overlay, options, selectedIndex, loading: false };
        if (!options.length) this.state.session.status = "no models configured";
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      if (this.isCurrentOperation("models", token) && this.overlayGeneration === overlayToken && this.state.overlay.kind === "models") {
        this.state.overlay = { ...this.state.overlay, options: [...this.lastModelOptions], loading: false, error: message };
        this.state.session.status = message;
      }
    } finally {
      this.finishOperation("models", token);
    }
    this.redraw();
  }

  async openFollowUps(): Promise<void> {
    if (this.busyOperation) return this.showBusyStatus();
    if (!this.options.loadFollowUps) {
      this.state.session.status = "follow-up queue is unavailable";
      this.redraw();
      return;
    }
    const token = this.beginOperation("follow-ups");
    if (token === undefined) return;
    const overlayToken = ++this.overlayGeneration;
    try {
      const options = await this.options.loadFollowUps();
      if (this.isCurrentOperation("follow-ups", token) && this.overlayGeneration === overlayToken && !this.destroyed) {
        this.state.overlay = { kind: "follow-ups", selectedIndex: 0, options };
        this.state.session.status = options.length ? `${options.length} follow-up(s) queued` : "no queued follow-ups";
      }
    } catch (error) {
      if (this.isCurrentOperation("follow-ups", token) && this.overlayGeneration === overlayToken) {
        this.state.session.status = formatErrorMessage(error);
      }
    } finally {
      this.finishOperation("follow-ups", token);
    }
    this.redraw();
  }

  async openSessions(): Promise<void> {
    if (this.isInteractionBlocked("finish or cancel the current task before switching sessions")) return;
    if (this.busyOperation) return this.showBusyStatus();
    if (!this.options.loadSessions) {
      this.state.session.status = "session history is unavailable";
      this.redraw();
      return;
    }
    const token = this.beginOperation("sessions");
    if (token === undefined) return;
    const overlayToken = ++this.overlayGeneration;
    this.state.session.status = "loading sessions...";
    this.state.overlay = { kind: "sessions", query: "", selectedIndex: 0, options: [] };
    this.setInput("", 0);
    this.redraw();
    try {
      const options = await this.options.loadSessions();
      if (this.isCurrentOperation("sessions", token) && this.overlayGeneration === overlayToken && this.state.overlay.kind === "sessions") {
        this.state.overlay = { ...this.state.overlay, options };
        if (!options.length) this.state.session.status = "no sessions in this workspace";
      }
    } catch (error) {
      if (this.isCurrentOperation("sessions", token) && this.overlayGeneration === overlayToken && this.state.overlay.kind === "sessions") {
        this.state.session.status = formatErrorMessage(error);
      }
    } finally {
      this.finishOperation("sessions", token);
    }
    this.redraw();
  }

  private async selectSession(id: string): Promise<void> {
    if (this.isInteractionBlocked("finish or cancel the current task before switching sessions")) return;
    if (!this.options.onSessionSelected) return;
    const token = this.beginOperation("session");
    if (token === undefined) return this.showBusyStatus();
    this.state.session.status = "restoring session...";
    this.redraw();
    try {
      const session = await this.options.onSessionSelected(id);
      if (this.isCurrentOperation("session", token)) {
        if (session) this.restoreSession(session);
        else this.state.session.status = "session not found";
      }
    } catch (error) {
      if (this.isCurrentOperation("session", token)) this.state.session.status = formatErrorMessage(error);
    } finally {
      this.finishOperation("session", token);
    }
    this.redraw();
  }

  private async deleteSession(id: string): Promise<void> {
    if (this.isInteractionBlocked("finish or cancel the current task before deleting a session")) return;
    if (!this.options.onSessionDeleted) {
      this.state.session.status = "session deletion is unavailable";
      this.redraw();
      return;
    }
    const returnSelectedIndex = this.state.overlay.kind === "session-delete-confirm"
      ? this.state.overlay.returnSelectedIndex
      : 0;
    const token = this.beginOperation("session");
    if (token === undefined) return this.showBusyStatus();
    this.state.session.status = "deleting session...";
    this.redraw();
    try {
      const activeSessionId = this.state.session.sessionId;
      const session = await this.options.onSessionDeleted(id);
      if (this.isCurrentOperation("session", token) && session) {
        if (session.id !== activeSessionId) this.restoreSession(session);
        this.state.session.status = "session deleted";
        const options = await this.options.loadSessions?.();
        if (options) {
          const selectedIndex = Math.min(returnSelectedIndex, Math.max(0, options.length - 1));
          this.state.overlay = { kind: "sessions", query: "", selectedIndex, options: [...options] };
        } else {
          this.state.overlay = { kind: "none" };
        }
      } else if (this.isCurrentOperation("session", token)) {
        this.state.session.status = "session could not be deleted";
      }
    } catch (error) {
      if (this.isCurrentOperation("session", token)) this.state.session.status = formatErrorMessage(error);
    } finally {
      this.finishOperation("session", token);
    }
    this.redraw();
  }

  private async createSession(): Promise<void> {
    if (this.isInteractionBlocked("finish or cancel the current task before creating a session")) return;
    if (!this.options.onSessionCreated) {
      this.setInput("/new", "/new".length);
      await this.submit();
      return;
    }
    this.closeOverlay();
    const token = this.beginOperation("session");
    if (token === undefined) return this.showBusyStatus();
    this.state.session.status = "starting new session...";
    this.redraw();
    try {
      const session = await this.options.onSessionCreated();
      if (this.isCurrentOperation("session", token) && session) {
        this.restoreSession(session);
        this.state.session.status = `started ${session.name}`;
      }
    } catch (error) {
      if (this.isCurrentOperation("session", token)) this.state.session.status = formatErrorMessage(error);
    } finally {
      this.finishOperation("session", token);
    }
    this.redraw();
  }

  private insertFileSelection(path: string): void {
    if (this.state.overlay.kind !== "files") return;
    const value = composerValue(this.state.composer);
    const cursor = composerOffset(this.state.composer);
    const replacement = `@${path}`;
    const next = `${value.slice(0, this.state.overlay.tokenStart)}${replacement}${value.slice(cursor)}`;
    this.setInput(next, this.state.overlay.tokenStart + replacement.length);
    this.closeOverlay();
    this.updateInputOverlay();
  }

  private async selectModel(reference: string): Promise<void> {
    if (this.isInteractionBlocked("finish or cancel the current task before changing the model")) return;
    const token = this.beginOperation("model");
    if (token === undefined) return this.showBusyStatus();
    this.state.session.status = `selecting ${reference}...`;
    this.redraw();
    try {
      const selected = await this.options.onModelSelected(reference);
      if (this.isCurrentOperation("model", token) && selected !== false) {
        delete this.state.session.modelWarning;
        const modelReference = parseModelReference(reference);
        if (modelReference) this.state.session.modelReference = modelReference;
        else delete this.state.session.modelReference;
        this.dismissOverlay();
        this.setInput("", 0);
        this.refreshContext();
      }
    } catch (error) {
      if (this.isCurrentOperation("model", token)) this.state.session.status = formatErrorMessage(error);
    } finally {
      this.finishOperation("model", token);
    }
    this.redraw();
  }

  private openApproval(call: ToolCall, level: number, description: string): Promise<ApprovalResponse> {
    this.cancelApproval();
    this.state.overlay = {
      kind: "approval",
      selectedIndex: 0,
      approval: { call, level, description, workspace: this.options.getWorkspace() },
    };
    this.state.session.status = "approval required";
    this.redraw();
    return new Promise<ApprovalResponse>((resolve) => {
      this.approvalResolve = resolve;
    });
  }

  private resolveApproval(response: ApprovalResponse): void {
    const resolveApproval = this.approvalResolve;
    this.approvalResolve = undefined;
    this.state.overlay = { kind: "none" };
    resolveApproval?.(response);
    if (!this.destroyed) this.redraw();
  }

  private cancelApproval(): void {
    if (this.approvalResolve) this.resolveApproval(false);
    else {
      if (this.state.overlay.kind === "approval") this.state.overlay = { kind: "none" };
    }
  }

  private updateInputOverlay(): void {
    const input = composerValue(this.state.composer);
    const file = fileQuery(input, composerOffset(this.state.composer));
    if (file && this.options.loadFiles) {
      const previous = this.state.overlay.kind === "files" ? this.state.overlay : undefined;
      this.state.overlay = { kind: "files", query: file.query, selectedIndex: previous?.query === file.query ? previous.selectedIndex : 0, options: previous?.query === file.query ? previous.options : [], loading: true, tokenStart: file.start };
      void this.options.loadFiles(file.query).then((options) => {
        if (this.state.overlay.kind === "files" && this.state.overlay.query === file.query && this.state.overlay.tokenStart === file.start) {
          this.state.overlay = { ...this.state.overlay, options, loading: false };
          this.redraw();
        }
      }).catch(() => undefined);
      return;
    }
    const shouldShow = input.startsWith("/") && !/\s/.test(input);
    const previousQuery = this.state.overlay.kind === "commands" ? this.state.overlay.query : "";
    const selectedIndex = this.state.overlay.kind === "commands" ? this.state.overlay.selectedIndex : 0;
    if (shouldShow) {
      if (this.dismissedCommandInput === input) return;
      this.dismissedCommandInput = undefined;
      const candidates = commandCandidates(input, this.state.commands);
      this.state.overlay = {
        kind: "commands",
        query: input,
        selectedIndex: Math.min(candidates.length - 1, Math.max(0, previousQuery === input ? selectedIndex : 0)),
      };
    } else if (this.state.overlay.kind === "commands") {
      this.state.overlay = { kind: "none" };
    }
  }

  private closeOverlay(): void {
    if (this.state.overlay.kind !== "approval") {
      if (this.busyOperation === "session" || this.busyOperation === "model" || this.busyOperation === "settings") {
        this.showBusyStatus();
        return;
      }
      const cancelledOperation = this.busyOperation;
      this.cancelOverlayOperation();
      this.dismissOverlay();
      if (cancelledOperation) this.state.session.status = `${cancelledOperation} operation cancelled`;
      this.redraw();
    }
  }

  private dismissOverlay(): void {
    if (this.state.overlay.kind === "approval") return;
    this.state.overlay = { kind: "none" };
  }

  private beginOperation(kind: NonNullable<TuiApp["busyOperation"]>): number | undefined {
    if (this.destroyed || this.busyOperation) return undefined;
    this.busyOperation = kind;
    return ++this.operationGeneration;
  }

  private isCurrentOperation(kind: NonNullable<TuiApp["busyOperation"]>, token: number): boolean {
    return !this.destroyed && this.busyOperation === kind && this.operationGeneration === token;
  }

  private finishOperation(kind: NonNullable<TuiApp["busyOperation"]>, token: number): void {
    if (!this.isCurrentOperation(kind, token)) return;
    this.busyOperation = undefined;
    this.operationGeneration += 1;
  }

  private cancelOverlayOperation(): void {
    this.overlayGeneration += 1;
    if (this.busyOperation) {
      this.operationGeneration += 1;
      this.busyOperation = undefined;
    }
  }

  private showBusyStatus(): void {
    if (this.busyOperation) this.state.session.status = `${this.busyOperation} operation in progress`;
    this.redraw();
  }

  private isInteractionBlocked(message: string): boolean {
    if (!this.options.isInteractionBlocked?.()) return false;
    this.state.session.status = message;
    this.redraw();
    return true;
  }

  private navigateInputHistory(direction: "older" | "newer"): void {
    const next = navigateHistory(
      this.state.composer.history,
      this.state.composer.historyIndex,
      direction,
      composerValue(this.state.composer),
      this.state.composer.historyDraft,
    );
    this.setInput(next.value, next.value.length);
    this.state.composer.historyIndex = next.index;
    this.state.composer.historyDraft = next.draft;
    this.updateInputOverlay();
  }

  private recordHistory(value: string): void {
    this.state.composer.history = [value, ...this.state.composer.history.filter((item: string) => item !== value)].slice(0, 1000);
  }

  private setInput(value: string, cursor: number): void {
    setComposerValue(this.state.composer, value);
    setComposerCursorOffset(this.state.composer, cursor);
  }

  private handleMouse(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const action = String((event as { action?: unknown }).action ?? "");
    if (action === "wheelup") this.layout.scrollTranscript(this.state, 3);
    else if (action === "wheeldown") this.layout.scrollTranscript(this.state, -3);
  }

  private setCommandSelection(selectedIndex: number): void {
    if (this.state.overlay.kind === "commands") {
      const count = commandCandidates(this.state.overlay.query, this.state.commands).length;
      this.state.overlay = { ...this.state.overlay, selectedIndex: Math.min(Math.max(0, count - 1), Math.max(0, selectedIndex)) };
    }
  }

  private setModelSelection(selectedIndex: number): void {
    if (this.state.overlay.kind === "models") this.state.overlay = { ...this.state.overlay, selectedIndex };
  }

  private setSessionSelection(selectedIndex: number): void {
    if (this.state.overlay.kind === "sessions") this.state.overlay = { ...this.state.overlay, selectedIndex };
  }

  private setApprovalSelection(selectedIndex: number): void {
    if (this.state.overlay.kind === "approval") this.state.overlay = { ...this.state.overlay, selectedIndex };
  }

  private finish(): void {
    this.resolveRun?.();
    this.resolveRun = undefined;
  }

  private redraw(): void {
    if (this.destroyed) return;
    this.syncOverlayFocus();
    this.layout.redraw(this.state);
  }

  private syncOverlayFocus(): void {
    const kind = this.state.overlay.kind;
    if (kind === "none") {
      return;
    }
  }

  private toggleLatestDetail(): void {
    this.layout.captureTranscriptAnchor(this.state);
    const reversed = [...this.state.transcript].reverse();
    const message = reversed.find((entry) => entry.kind === "thought")
      ?? reversed.find((entry) => entry.kind === "tool");
    if (message?.kind !== "tool" && message?.kind !== "thought") return;
    message.expanded = !message.expanded;
    this.redraw();
  }

  private sessionView(): SessionView {
    return {
      id: this.state.session.sessionId,
      name: this.state.session.sessionName,
      messages: this.state.transcript.map((message) => ({ ...message })),
      history: [...this.state.composer.history],
      workMode: this.state.session.workMode,
      permissionMode: this.state.session.permissionMode,
      reasoningEffort: this.state.session.reasoningEffort,
      ...(this.state.session.modelReference ? { modelReference: { ...this.state.session.modelReference } } : {}),
      ...(this.state.session.modelWarning ? { modelWarning: this.state.session.modelWarning } : {}),
    };
  }

  private restoreSession(session: SessionView): void {
    const previousTaskId = this.state.activeTaskId;
    if (previousTaskId) this.state.retiredTaskIds.add(previousTaskId);
    this.state.session.sessionId = session.id;
    this.state.session.sessionName = session.name;
    this.state.session.workMode = session.workMode ?? this.options.getWorkMode?.() ?? "auto";
    this.state.session.permissionMode = session.permissionMode ?? this.options.getPermissionMode?.() ?? (this.state.session.workMode === "plan" ? "plan" : "default");
    this.state.session.reasoningEffort = session.reasoningEffort ?? this.options.getReasoningEffort?.() ?? "medium";
    if (session.modelReference) this.state.session.modelReference = { ...session.modelReference };
    else {
      const reference = this.options.getModelReference?.();
      if (reference) this.state.session.modelReference = { ...reference };
      else delete this.state.session.modelReference;
    }
    if (session.modelWarning) this.state.session.modelWarning = session.modelWarning;
    else delete this.state.session.modelWarning;
    this.state.transcript = session.messages.map((message) => ({ ...message }));
    if (session.modelWarning && !this.state.transcript.some((message) => message.kind === "error" && message.text === session.modelWarning)) {
      appendSystemMessage(this.state, session.modelWarning, "error");
    }
    this.state.composer.history = [...session.history];
    this.state.composer.historyIndex = undefined;
    this.state.composer.historyDraft = "";
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
    this.state.session.followUpCount = 0;
    this.setInput("", 0);
    this.dismissOverlay();
    this.state.transcriptScroll = { offsetFromBottom: 0, followBottom: true };
    this.state.lastTranscriptLines = 0;
    this.refreshContext();
  }

  private editorWidth(): number {
    return Math.max(1, this.screen.cols - 4);
  }

  private canMoveComposerVertically(direction: "up" | "down"): boolean {
    const lines = visualLines(this.state.composer, this.editorWidth());
    if (lines.length <= 1) return false;
    const position = cursorVisualPosition(this.state.composer, this.editorWidth());
    return direction === "up" ? position.row > 0 : position.row < lines.length - 1;
  }
}

function nextMessageNumber(transcript: readonly TuiState["transcript"][number][]): number {
  let maximum = 0;
  for (const message of transcript) {
    const match = /^message-(\d+)$/.exec(message.id);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

function composerOffset(composer: TuiState["composer"]): number {
  let offset = 0;
  for (let index = 0; index < composer.cursor.line; index += 1) offset += (composer.lines[index]?.length ?? 0) + 1;
  return offset + composer.cursor.column;
}

function fileQuery(value: string, cursor: number): { query: string; start: number } | undefined {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return undefined;
  const at = before.lastIndexOf("@");
  return { query: match[1] ?? "", start: at };
}

function isPrintable(ch: string, key: Widgets.Events.IKeyEventArg): boolean {
  return Boolean(ch) && !key.ctrl && !key.meta && ch !== "\r" && ch !== "\n";
}

function parseModelReference(value: string): ModelReference | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}
