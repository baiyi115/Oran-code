import type { Key } from "ink";
import type { ApprovalResponse } from "../types.js";
import type { SessionOption, SessionView, TuiState } from "./types.js";
import { composerValue, setComposerValue, setOverlay } from "./state.js";
import { composerCursorOffset } from "./composer.js";
import { commandCandidates } from "./command-palette.js";
import { approvalResponse, moveSelection } from "./interaction.js";
import { formatErrorMessage } from "../error-format.js";
import { isSessionDeleteKey, isSubmitKey } from "./keys.js";
import { fileQuery } from "./render.jsx";

/**
 * Overlay 键处理状态机与 InkTuiApp 之间的上下文。app 保留渲染调度、composer
 * 主编辑、会话恢复与提交;handlers 只负责 overlay 的打开/选择/确认。
 */
export interface OverlayHandlerContext {
  readonly state: TuiState;
  readonly loadModels: () => Promise<string[]>;
  readonly loadSessions?: () => Promise<SessionOption[]> | Promise<SessionOption[] | undefined> | Promise<SessionOption[]>;
  readonly onSessionSelected?: (id: string) => Promise<SessionView | undefined>;
  readonly onSessionDeleted?: (id: string) => Promise<SessionView | undefined>;
  readonly onModelSelected: (reference: string) => Promise<boolean | void>;
  readonly loadFollowUps?: () => Promise<import("./types.js").FollowUpOption[]> | import("./types.js").FollowUpOption[];
  readonly onFollowUpCancelled?: (id: string) => Promise<boolean> | boolean;
  invalidate(): void;
  rejectIfBlocked(message: string): boolean;
  refreshContext(): void;
  restoreSessionView(session: SessionView, notice?: string): void;
  restoreSession(session: SessionView): void;
  submit(forcedCommand?: string): Promise<void>;
  handleComposerKey(input: string, key: Key): void;
  detachInputHistory(): void;
  /** Esc 关闭命令面板时记录当前输入,避免打字时面板重弹。 */
  noteDismissedCommandInput(value: string): void;
  resolveApproval(response: ApprovalResponse): void;
}

/**
 * 命令面板/模型/会话/文件补全/follow-up/审批 overlay 的键状态机。
 * 从 InkTuiApp 提取,行为保持不变;互斥的选中索引统一存放在
 * state.overlay.selectedIndex。
 */
export class OverlayHandlers {
  private followUpBusy = false;
  private deletingSession = false;
  private selectingSession = false;

  constructor(private readonly ctx: OverlayHandlerContext) {}

  async openModels(): Promise<void> {
    if (this.ctx.rejectIfBlocked("finish or cancel the current task before switching models")) return;
    try {
      const options = await this.ctx.loadModels();
      setOverlay(this.ctx.state, { kind: "models", query: "", selectedIndex: 0, options, loading: false });
    } catch (error) {
      setOverlay(this.ctx.state, { kind: "models", query: "", selectedIndex: 0, options: [], loading: false, error: formatErrorMessage(error) });
    }
    this.ctx.invalidate();
  }

  async openSessions(): Promise<void> {
    if (this.ctx.rejectIfBlocked("finish or cancel the current task before switching sessions")) return;
    if (!this.ctx.loadSessions) return;
    try {
      const options = await this.ctx.loadSessions();
      setOverlay(this.ctx.state, { kind: "sessions", query: "", selectedIndex: 0, options: options ?? [] });
    } catch (error) {
      this.ctx.state.session.status = formatErrorMessage(error);
    }
    this.ctx.invalidate();
  }

  async openFollowUps(): Promise<void> {
    if (this.followUpBusy) return;
    if (!this.ctx.loadFollowUps) {
      this.ctx.state.session.status = "follow-up queue is unavailable";
      this.ctx.invalidate();
      return;
    }
    this.followUpBusy = true;
    try {
      const options = await this.ctx.loadFollowUps();
      this.ctx.state.overlay = { kind: "follow-ups", selectedIndex: 0, options: [...options] };
      this.ctx.state.session.status = options.length ? `${options.length} follow-up(s) queued` : "no queued follow-ups";
    } catch (error) {
      this.ctx.state.session.status = formatErrorMessage(error);
    } finally {
      this.followUpBusy = false;
    }
    this.ctx.invalidate();
  }

  handleCommandKey(input: string, key: Key): void {
    const candidates = commandCandidates(composerValue(this.ctx.state.composer), this.ctx.state.commands);
    if (this.ctx.state.overlay.kind !== "commands") return;
    if (key.upArrow) {
      this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: candidates.length ? (this.ctx.state.overlay.selectedIndex - 1 + candidates.length) % candidates.length : 0 };
    }
    else if (key.downArrow) {
      this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: candidates.length ? (this.ctx.state.overlay.selectedIndex + 1) % candidates.length : 0 };
    }
    else if (key.tab) {
      const command = candidates[this.ctx.state.overlay.selectedIndex];
      if (command) {
        this.ctx.detachInputHistory();
        setComposerValue(this.ctx.state.composer, `${command.name} `);
      }
      this.ctx.state.overlay = { kind: "none" };
    } else if (isSubmitKey(input, key)) {
      const command = candidates[this.ctx.state.overlay.selectedIndex];
      void this.ctx.submit(command?.name);
      return;
    } else if (key.escape) {
      this.ctx.noteDismissedCommandInput(composerValue(this.ctx.state.composer));
      this.ctx.state.overlay = { kind: "none" };
    }
    else {
      this.ctx.handleComposerKey(input, key);
      return;
    }
    this.ctx.invalidate();
  }

  handleModelKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "models") return;
    const options = this.ctx.state.overlay.options;
    if (key.upArrow) this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: Math.max(0, this.ctx.state.overlay.selectedIndex - 1) };
    else if (key.downArrow) this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: Math.min(Math.max(0, options.length - 1), this.ctx.state.overlay.selectedIndex + 1) };
    else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else if (isSubmitKey(input, key)) {
      const selected = options[this.ctx.state.overlay.selectedIndex];
      if (selected) void this.selectModel(selected);
    }
    this.ctx.invalidate();
  }

  async selectModel(reference: string): Promise<void> {
    const changed = await this.ctx.onModelSelected(reference);
    if (changed !== false) this.ctx.state.overlay = { kind: "none" };
    this.ctx.refreshContext();
  }

  handleSessionKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "sessions") return;
    if (this.selectingSession) return;
    const options = this.ctx.state.overlay.options;
    if (key.upArrow) this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: Math.max(0, this.ctx.state.overlay.selectedIndex - 1) };
    else if (key.downArrow) this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: Math.min(Math.max(0, options.length - 1), this.ctx.state.overlay.selectedIndex + 1) };
    else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else if (isSessionDeleteKey(input, key)) {
      const selected = options[this.ctx.state.overlay.selectedIndex];
      if (selected) this.requestSessionDelete(selected);
    }
    else if (isSubmitKey(input, key)) {
      const selected = options[this.ctx.state.overlay.selectedIndex];
      if (selected && this.ctx.onSessionSelected) void this.selectSession(selected.id);
    }
    this.ctx.invalidate();
  }

  async selectSession(id: string): Promise<void> {
    if (this.selectingSession) return;
    this.selectingSession = true;
    try {
      const session = await this.ctx.onSessionSelected?.(id);
      if (session) this.ctx.restoreSessionView(session, `Restored session ${session.id}: ${session.name}.`);
      else this.ctx.state.overlay = { kind: "none" };
    } finally {
      this.selectingSession = false;
      this.ctx.invalidate();
    }
  }

  handleFileKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "files") return;
    if (key.upArrow) this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: moveSelection(this.ctx.state.overlay.selectedIndex, -1, this.ctx.state.overlay.options.length) };
    else if (key.downArrow) this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: moveSelection(this.ctx.state.overlay.selectedIndex, 1, this.ctx.state.overlay.options.length) };
    else if (key.tab || isSubmitKey(input, key)) {
      const file = this.ctx.state.overlay.options[this.ctx.state.overlay.selectedIndex];
      if (file) {
        const value = composerValue(this.ctx.state.composer);
        const cursor = composerCursorOffset(this.ctx.state.composer);
        const replacement = `@${file}`;
        const next = `${value.slice(0, this.ctx.state.overlay.tokenStart)}${replacement}${value.slice(cursor)}`;
        this.ctx.detachInputHistory();
        setComposerValue(this.ctx.state.composer, `${next} `);
        this.ctx.state.overlay = { kind: "none" };
      }
    } else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else {
      this.ctx.handleComposerKey(input, key);
      return;
    }
    this.ctx.invalidate();
  }

  private requestSessionDelete(selected: SessionOption): void {
    if (this.ctx.rejectIfBlocked("finish or cancel the current task before deleting a session")) return;
    if (this.deletingSession || this.ctx.state.overlay.kind !== "sessions") return;
    this.ctx.state.overlay = {
      kind: "session-delete-confirm",
      sessionId: selected.id,
      sessionName: selected.name,
      selectedIndex: 0,
      returnSelectedIndex: this.ctx.state.overlay.selectedIndex,
      options: [...this.ctx.state.overlay.options],
    };
    this.ctx.invalidate();
  }

  async handleSessionDeleteConfirmKey(input: string, key: Key): Promise<void> {
    if (this.ctx.state.overlay.kind !== "session-delete-confirm" || this.deletingSession) return;
    const overlay = this.ctx.state.overlay;
    if (key.leftArrow || key.upArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: 0 };
    else if (key.rightArrow || key.downArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: 1 };
    else if (key.escape) this.cancelSessionDeleteConfirmation();
    else if (isSessionDeleteKey(input, key) || isSubmitKey(input, key)) {
      if (isSessionDeleteKey(input, key) || overlay.selectedIndex === 0) {
        this.deletingSession = true;
        try {
          const activeSessionId = this.ctx.state.session.sessionId;
          const session = await this.ctx.onSessionDeleted?.(overlay.sessionId);
          if (session) {
            if (session.id !== activeSessionId) this.ctx.restoreSession(session);
            this.ctx.state.session.status = "session deleted";
            const options = await this.ctx.loadSessions?.();
            if (options) {
              this.ctx.state.overlay = {
                kind: "sessions",
                query: "",
                selectedIndex: Math.min(overlay.returnSelectedIndex, Math.max(0, options.length - 1)),
                options: [...options],
              };
            } else {
              this.ctx.state.overlay = { kind: "none" };
            }
          } else {
            this.ctx.state.session.status = "session could not be deleted";
          }
        } catch (error) {
          this.ctx.state.session.status = formatErrorMessage(error);
          this.ctx.state.overlay = { kind: "sessions", query: "", selectedIndex: overlay.returnSelectedIndex, options: overlay.options };
        } finally {
          this.deletingSession = false;
        }
      } else this.cancelSessionDeleteConfirmation();
    }
    this.ctx.invalidate();
  }

  private cancelSessionDeleteConfirmation(): void {
    if (this.ctx.state.overlay.kind !== "session-delete-confirm") return;
    const overlay = this.ctx.state.overlay;
    this.ctx.state.overlay = { kind: "sessions", query: "", selectedIndex: overlay.returnSelectedIndex, options: overlay.options };
    this.ctx.invalidate();
  }

  async handleFollowUpKey(input: string, key: Key): Promise<void> {
    if (this.ctx.state.overlay.kind !== "follow-ups" || this.followUpBusy) return;
    const overlay = this.ctx.state.overlay;
    if (key.upArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: moveSelection(overlay.selectedIndex, -1, overlay.options.length) };
    else if (key.downArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: moveSelection(overlay.selectedIndex, 1, overlay.options.length) };
    else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else if (isSubmitKey(input, key)) {
      const selected = overlay.options[overlay.selectedIndex];
      if (selected && this.ctx.onFollowUpCancelled) {
        this.followUpBusy = true;
        try {
          if (await this.ctx.onFollowUpCancelled(selected.id)) {
            const options = await this.ctx.loadFollowUps?.() ?? overlay.options.filter((item) => item.id !== selected.id);
            this.ctx.state.overlay = { kind: "follow-ups", selectedIndex: Math.min(overlay.selectedIndex, Math.max(0, options.length - 1)), options: [...options] };
          }
        } catch (error) {
          this.ctx.state.session.status = formatErrorMessage(error);
        } finally {
          this.followUpBusy = false;
        }
      }
    }
    this.ctx.invalidate();
  }

  handleApprovalKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "approval") return;
    const selected = this.ctx.state.overlay.selectedIndex;
    const next = key.upArrow ? Math.max(0, selected - 1) : key.downArrow ? Math.min(3, selected + 1) : selected;
    if (key.escape) this.ctx.resolveApproval(false);
    else if (isSubmitKey(input, key)) this.ctx.resolveApproval(approvalResponse(next));
    else this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: next };
    this.ctx.invalidate();
  }
}
