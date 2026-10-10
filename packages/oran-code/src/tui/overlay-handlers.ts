import type { Key } from "ink";
import type { ApprovalResponse } from "../types.js";
import type { SessionOption, SessionView, TuiState } from "./types.js";
import { composerValue, setComposerValue, setOverlay } from "./state.js";
import { composerCursorOffset } from "./composer.js";
import { commandCandidates } from "./command-palette.js";
import { approvalResponse, moveSelection } from "./interaction.js";
import { formatErrorMessage } from "../error-format.js";
import { isSessionDeleteKey, isSubmitKey } from "./keys.js";

/**
 * Context between the overlay key state machine and InkTuiApp. The app keeps render scheduling,
 * composer editing, session restore and submit; the handlers only open/select/confirm overlays.
 */
export interface OverlayHandlerContext {
  readonly state: TuiState;
  readonly loadModels: () => Promise<string[]>;
  readonly loadSessions?: () =>
    Promise<SessionOption[]> | Promise<SessionOption[] | undefined> | Promise<SessionOption[]>;
  readonly onSessionSelected?: (id: string) => Promise<SessionView | undefined>;
  readonly onSessionDeleted?: (id: string) => Promise<SessionView | undefined>;
  readonly onModelSelected: (reference: string) => Promise<boolean | void>;
  readonly loadProviders?: () => Promise<import("./types.js").ProviderOption[]>;
  readonly onProviderSelected?: (name: string) => Promise<boolean | void>;
  readonly onProviderDeleted?: (name: string) => Promise<boolean>;
  /** The add entry in the provider list: opens a blank connect wizard. */
  readonly openConnect?: () => void;
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
  /** Records the current input when Esc closes the command palette, so typing does not reopen it. */
  noteDismissedCommandInput(value: string): void;
  resolveApproval(response: ApprovalResponse): void;
  resolveQuestion(answers: Record<string, string>): void;
}

/**
 * Key state machine for the command palette/model/session/file-completion/follow-up/approval
 * overlays. Extracted from InkTuiApp with behavior unchanged; the mutually exclusive selection
 * index lives in state.overlay.selectedIndex.
 */
export class OverlayHandlers {
  private followUpBusy = false;
  private deletingEntry = false;
  private selectingSession = false;

  constructor(private readonly ctx: OverlayHandlerContext) {}

  async openModels(): Promise<void> {
    if (this.ctx.rejectIfBlocked("finish or cancel the current task before switching models")) return;
    try {
      const options = await this.ctx.loadModels();
      setOverlay(this.ctx.state, { kind: "models", query: "", selectedIndex: 0, options, loading: false });
    } catch (error) {
      setOverlay(this.ctx.state, {
        kind: "models",
        query: "",
        selectedIndex: 0,
        options: [],
        loading: false,
        error: formatErrorMessage(error),
      });
    }
    this.ctx.invalidate();
  }

  /** Provider management list: the no-argument entry point of /connect. Rows = providers + 1 (add row). */
  async openProviders(): Promise<void> {
    if (this.ctx.rejectIfBlocked("finish or cancel the current task before managing providers")) return;
    if (!this.ctx.loadProviders) return;
    try {
      const options = await this.ctx.loadProviders();
      setOverlay(this.ctx.state, { kind: "providers", selectedIndex: 0, options: [...options] });
    } catch (error) {
      this.ctx.state.session.status = formatErrorMessage(error);
    }
    this.ctx.invalidate();
  }

  handleProvidersKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "providers") return;
    const options = this.ctx.state.overlay.options;
    const rowCount = options.length + 1;
    if (key.upArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: Math.max(0, this.ctx.state.overlay.selectedIndex - 1),
      };
    else if (key.downArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: Math.min(rowCount - 1, this.ctx.state.overlay.selectedIndex + 1),
      };
    else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else if (input === "a" || input === "A") {
      this.ctx.openConnect?.();
    } else if (input === "d" || input === "D" || isSessionDeleteKey(input, key)) {
      const selected = options[this.ctx.state.overlay.selectedIndex];
      if (selected) this.requestProviderDelete(selected);
    } else if (isSubmitKey(input, key)) {
      if (this.ctx.state.overlay.selectedIndex >= options.length) {
        this.ctx.openConnect?.();
        return;
      }
      const selected = options[this.ctx.state.overlay.selectedIndex];
      if (selected && this.ctx.onProviderSelected) void this.ctx.onProviderSelected(selected.name);
    }
    this.ctx.invalidate();
  }

  private requestProviderDelete(selected: import("./types.js").ProviderOption): void {
    if (this.ctx.rejectIfBlocked("finish or cancel the current task before deleting a provider")) return;
    if (this.ctx.state.overlay.kind !== "providers" || !this.ctx.onProviderDeleted) return;
    this.ctx.state.overlay = {
      kind: "provider-delete-confirm",
      providerName: selected.name,
      selectedIndex: 1,
      returnSelectedIndex: this.ctx.state.overlay.selectedIndex,
      options: [...this.ctx.state.overlay.options],
    };
    this.ctx.invalidate();
  }

  async handleProviderDeleteConfirmKey(input: string, key: Key): Promise<void> {
    if (this.ctx.state.overlay.kind !== "provider-delete-confirm" || this.deletingEntry) return;
    const overlay = this.ctx.state.overlay;
    if (key.leftArrow || key.upArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: 0 };
    else if (key.rightArrow || key.downArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: 1 };
    else if (key.escape) this.cancelProviderDeleteConfirmation();
    else if (isSubmitKey(input, key)) {
      // Same as the session confirm layer: delete only when Enter lands on Delete.
      if (overlay.selectedIndex === 0) {
        this.deletingEntry = true;
        try {
          const deleted = await this.ctx.onProviderDeleted?.(overlay.providerName);
          if (deleted) {
            const options = (await this.ctx.loadProviders?.()) ?? [];
            this.ctx.state.overlay = {
              kind: "providers",
              selectedIndex: Math.min(overlay.returnSelectedIndex, Math.max(0, options.length - 1)),
              options: [...options],
            };
          }
          // On failure the handler has already surfaced the error; stay on the confirm layer so the
          // user can cancel.
        } catch (error) {
          this.ctx.state.session.status = formatErrorMessage(error);
          this.cancelProviderDeleteConfirmation();
        } finally {
          this.deletingEntry = false;
        }
      } else this.cancelProviderDeleteConfirmation();
    }
    this.ctx.invalidate();
  }

  private cancelProviderDeleteConfirmation(): void {
    if (this.ctx.state.overlay.kind !== "provider-delete-confirm") return;
    const overlay = this.ctx.state.overlay;
    this.ctx.state.overlay = {
      kind: "providers",
      selectedIndex: overlay.returnSelectedIndex,
      options: overlay.options,
    };
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
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: candidates.length
          ? (this.ctx.state.overlay.selectedIndex - 1 + candidates.length) % candidates.length
          : 0,
      };
    } else if (key.downArrow) {
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: candidates.length ? (this.ctx.state.overlay.selectedIndex + 1) % candidates.length : 0,
      };
    } else if (key.tab) {
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
    } else {
      this.ctx.handleComposerKey(input, key);
      return;
    }
    this.ctx.invalidate();
  }

  handleModelKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "models") return;
    const options = this.ctx.state.overlay.options;
    if (key.upArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: Math.max(0, this.ctx.state.overlay.selectedIndex - 1),
      };
    else if (key.downArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: Math.min(Math.max(0, options.length - 1), this.ctx.state.overlay.selectedIndex + 1),
      };
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
    if (key.upArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: Math.max(0, this.ctx.state.overlay.selectedIndex - 1),
      };
    else if (key.downArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: Math.min(Math.max(0, options.length - 1), this.ctx.state.overlay.selectedIndex + 1),
      };
    else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else if (isSessionDeleteKey(input, key)) {
      const selected = options[this.ctx.state.overlay.selectedIndex];
      if (selected) this.requestSessionDelete(selected);
    } else if (isSubmitKey(input, key)) {
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
    if (key.upArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: moveSelection(this.ctx.state.overlay.selectedIndex, -1, this.ctx.state.overlay.options.length),
      };
    else if (key.downArrow)
      this.ctx.state.overlay = {
        ...this.ctx.state.overlay,
        selectedIndex: moveSelection(this.ctx.state.overlay.selectedIndex, 1, this.ctx.state.overlay.options.length),
      };
    else if (key.tab || isSubmitKey(input, key)) {
      const file = this.ctx.state.overlay.options[this.ctx.state.overlay.selectedIndex];
      if (file) {
        const value = composerValue(this.ctx.state.composer);
        const cursor = composerCursorOffset(this.ctx.state.composer);
        // A path with spaces must be quoted: otherwise the inserted @a b.txt is cut at the first
        // space, the completion popup closes, and the reference is no longer a single unit.
        const replacement = /\s/.test(file) ? `@"${file}"` : `@${file}`;
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
    if (this.deletingEntry || this.ctx.state.overlay.kind !== "sessions") return;
    this.ctx.state.overlay = {
      kind: "session-delete-confirm",
      sessionId: selected.id,
      sessionName: selected.name,
      // Defaults to Cancel, matching the provider delete confirmation — the default for deleting
      // is "do nothing".
      selectedIndex: 1,
      returnSelectedIndex: this.ctx.state.overlay.selectedIndex,
      options: [...this.ctx.state.overlay.options],
    };
    this.ctx.invalidate();
  }

  async handleSessionDeleteConfirmKey(input: string, key: Key): Promise<void> {
    if (this.ctx.state.overlay.kind !== "session-delete-confirm" || this.deletingEntry) return;
    const overlay = this.ctx.state.overlay;
    if (key.leftArrow || key.upArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: 0 };
    else if (key.rightArrow || key.downArrow) this.ctx.state.overlay = { ...overlay, selectedIndex: 1 };
    else if (key.escape) this.cancelSessionDeleteConfirmation();
    else if (isSubmitKey(input, key)) {
      // Delete only when Enter lands on Delete. Backspace/Del used to delete regardless of the
      // highlight, so a single press with Cancel focused deleted it — that route is closed, leaving
      // only the explicit Enter confirmation.
      if (overlay.selectedIndex === 0) {
        this.deletingEntry = true;
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
          this.ctx.state.overlay = {
            kind: "sessions",
            query: "",
            selectedIndex: overlay.returnSelectedIndex,
            options: overlay.options,
          };
        } finally {
          this.deletingEntry = false;
        }
      } else this.cancelSessionDeleteConfirmation();
    }
    this.ctx.invalidate();
  }

  private cancelSessionDeleteConfirmation(): void {
    if (this.ctx.state.overlay.kind !== "session-delete-confirm") return;
    const overlay = this.ctx.state.overlay;
    this.ctx.state.overlay = {
      kind: "sessions",
      query: "",
      selectedIndex: overlay.returnSelectedIndex,
      options: overlay.options,
    };
    this.ctx.invalidate();
  }

  async handleFollowUpKey(input: string, key: Key): Promise<void> {
    if (this.ctx.state.overlay.kind !== "follow-ups" || this.followUpBusy) return;
    const overlay = this.ctx.state.overlay;
    if (key.upArrow)
      this.ctx.state.overlay = {
        ...overlay,
        selectedIndex: moveSelection(overlay.selectedIndex, -1, overlay.options.length),
      };
    else if (key.downArrow)
      this.ctx.state.overlay = {
        ...overlay,
        selectedIndex: moveSelection(overlay.selectedIndex, 1, overlay.options.length),
      };
    else if (key.escape) this.ctx.state.overlay = { kind: "none" };
    else if (isSubmitKey(input, key)) {
      const selected = overlay.options[overlay.selectedIndex];
      if (selected && this.ctx.onFollowUpCancelled) {
        this.followUpBusy = true;
        try {
          if (await this.ctx.onFollowUpCancelled(selected.id)) {
            const options =
              (await this.ctx.loadFollowUps?.()) ?? overlay.options.filter((item) => item.id !== selected.id);
            this.ctx.state.overlay = {
              kind: "follow-ups",
              selectedIndex: Math.min(overlay.selectedIndex, Math.max(0, options.length - 1)),
              options: [...options],
            };
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
    // Quick answers match the readline side (y / n). A single-key "always allow" is deliberately
    // not offered: the user is often still typing when the approval dialog pops up, and one
    // mistyped key would hand over the whole session's authorization, whereas a mistyped y/n only
    // affects this one call; to always allow, select it with the arrow keys and press Enter.
    else if (!key.ctrl && !key.meta && input.toLowerCase() === "y") this.ctx.resolveApproval(true);
    else if (!key.ctrl && !key.meta && input.toLowerCase() === "n") this.ctx.resolveApproval(false);
    else this.ctx.state.overlay = { ...this.ctx.state.overlay, selectedIndex: next };
    this.ctx.invalidate();
  }

  handleQuestionKey(input: string, key: Key): void {
    if (this.ctx.state.overlay.kind !== "question") return;
    const overlay = this.ctx.state.overlay;
    const currentQ = overlay.questions[overlay.currentQuestionIndex];
    if (!currentQ) {
      this.ctx.resolveQuestion({});
      return;
    }

    if (key.upArrow) {
      this.ctx.state.overlay = {
        ...overlay,
        selectedIndex: Math.max(0, overlay.selectedIndex - 1),
      };
      this.ctx.invalidate();
      return;
    }

    if (key.downArrow) {
      this.ctx.state.overlay = {
        ...overlay,
        selectedIndex: Math.min(currentQ.options.length - 1, overlay.selectedIndex + 1),
      };
      this.ctx.invalidate();
      return;
    }

    if (currentQ.multiSelect && input === " ") {
      const idx = overlay.selectedIndex;
      const currentSelected = [...overlay.selectedIndices];
      const existing = currentSelected.indexOf(idx);
      if (existing >= 0) {
        currentSelected.splice(existing, 1);
      } else {
        currentSelected.push(idx);
      }
      this.ctx.state.overlay = {
        ...overlay,
        selectedIndices: currentSelected,
      };
      this.ctx.invalidate();
      return;
    }

    if (key.escape) {
      const fallbackAnswers = { ...overlay.answers };
      for (let i = overlay.currentQuestionIndex; i < overlay.questions.length; i++) {
        const q = overlay.questions[i];
        if (q) {
          fallbackAnswers[q.question] = q.options[0]?.label ?? "Yes";
        }
      }
      this.ctx.resolveQuestion(fallbackAnswers);
      return;
    }

    if (isSubmitKey(input, key)) {
      const updatedAnswers = { ...overlay.answers };
      if (currentQ.multiSelect) {
        const selectedLabels = overlay.selectedIndices.map((i) => currentQ.options[i]?.label).filter(Boolean);
        updatedAnswers[currentQ.question] =
          selectedLabels.length > 0 ? selectedLabels.join(", ") : (currentQ.options[0]?.label ?? "None");
      } else {
        const chosen = currentQ.options[overlay.selectedIndex];
        updatedAnswers[currentQ.question] = chosen?.label ?? currentQ.options[0]?.label ?? "Yes";
      }

      if (overlay.currentQuestionIndex < overlay.questions.length - 1) {
        this.ctx.state.overlay = {
          ...overlay,
          currentQuestionIndex: overlay.currentQuestionIndex + 1,
          selectedIndex: 0,
          selectedIndices: [],
          answers: updatedAnswers,
        };
        this.ctx.invalidate();
        return;
      }

      this.ctx.resolveQuestion(updatedAnswers);
    }
  }
}
