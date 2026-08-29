/**
 * 会话 CRUD 服务：列表 / 切换 / 新建 / 删除 / 重命名。
 * 从 TerminalSession 提取（loadSessionOptions/toSessionView/selectSession/
 * deleteSession/createSession/renameSession），行为保持不变。
 * 会话选择去重（sessionSelection）与切换/删除/新建流程一并内聚在本服务，
 * TerminalSession 通过端口提供状态读写与副作用回调。
 */
import type { ContextManager } from "./context-manager.js";
import { sessionOptionsFromStore, toSessionView as toSessionViewOf, workModeForPermission } from "./session-lifecycle.js";
import type { SessionStore, StoredSession } from "./session-store.js";
import type { Message, ModelConfig, ModelReference, PermissionMode, ReasoningEffort, WorkMode } from "./types.js";
import type { SessionOption, SessionView } from "./tui/types.js";

export interface SessionCrudPort {
  persistTuiSession(persist?: boolean): Promise<void>;
  readonly sessionStore: SessionStore;
  currentSession(): StoredSession | undefined;
  setCurrentSession(session: StoredSession | undefined): void;
  sessionName(session: StoredSession): string;
  model(): ModelConfig | undefined;
  modelWarning(): string | undefined;
  setModelWarning(warning: string | undefined): void;
  explicitModel(): boolean;
  modelReference(model: ModelConfig): ModelReference;
  interactionRunning(): boolean;
  hasPendingApprovals(): boolean;
  cancelTask(): void;
  waitForInteraction(): Promise<void>;
  restoreStoredSession(stored: StoredSession, applyModel: boolean): Promise<void>;
  refreshTui(): void;
  clearFollowUps(): void;
  clearPendingPlanExecute(): void;
  previousPlanPermissionMode(): PermissionMode | undefined;
  setPreviousPlanPermissionMode(mode: PermissionMode | undefined): void;
  bumpSessionGeneration(): void;
  setConversation(messages: Message[]): void;
  resetHookOnce(): void;
  refreshSessionKnowledge(): Promise<void>;
  deleteContextManager(sessionId: string): void;
  ensureCurrentContextManager(): Promise<ContextManager>;
  permissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  workMode(): WorkMode;
  setWorkMode(mode: WorkMode): void;
  reasoningEffort(): ReasoningEffort;
  setReasoningEffort(value: ReasoningEffort): void;
}

export class SessionCrudService {
  private selection: Promise<SessionView | undefined> | undefined;

  constructor(private readonly port: SessionCrudPort) {}

  async loadSessionOptions(): Promise<SessionOption[]> {
    await this.port.persistTuiSession();
    return sessionOptionsFromStore(this.port.sessionStore.list(), this.port.currentSession()?.id, (session) => this.port.sessionName(session));
  }

  toSessionView(session: StoredSession): SessionView {
    const active = this.port.currentSession()?.id === session.id;
    const model = this.port.model();
    const warning = this.port.modelWarning();
    return toSessionViewOf(session, {
      displayName: this.port.sessionName(session),
      ...(active && model ? { activeModelReference: this.port.modelReference(model) } : {}),
      ...(active && warning ? { activeModelWarning: warning } : {}),
    });
  }

  async selectSession(id: string): Promise<SessionView | undefined> {
    if (this.selection) return this.selection;
    let selection: Promise<SessionView | undefined>;
    selection = this.selectSessionUnlocked(id).finally(() => {
      if (this.selection === selection) this.selection = undefined;
    });
    this.selection = selection;
    return selection;
  }

  private async selectSessionUnlocked(id: string): Promise<SessionView | undefined> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.cancelTask();
      await this.port.waitForInteraction();
    }
    await this.port.persistTuiSession();
    const stored = await this.port.sessionStore.ensureConversation(id) ?? this.port.sessionStore.find(id);
    if (!stored) return undefined;
    await this.port.restoreStoredSession(stored, !this.port.explicitModel());
    await this.port.persistTuiSession(false);
    this.port.clearFollowUps();
    this.port.clearPendingPlanExecute();
    this.port.setPreviousPlanPermissionMode(undefined);
    this.port.refreshTui();
    return this.toSessionView(this.port.currentSession() ?? stored);
  }

  async deleteSession(id: string): Promise<SessionView | undefined> {
    if (this.selection || this.port.interactionRunning() || this.port.hasPendingApprovals()) return undefined;
    await this.port.persistTuiSession();
    const activeId = this.port.currentSession()?.id;
    const removed = await this.port.sessionStore.remove(id);
    if (!removed) return undefined;
    this.port.deleteContextManager(id);
    this.port.clearFollowUps();
    this.port.clearPendingPlanExecute();
    this.port.setPreviousPlanPermissionMode(undefined);
    if (id === activeId) {
      const replacement = await this.port.sessionStore.ensureCurrent("Current session", {
        workMode: this.port.workMode(),
        permissionMode: this.port.permissionMode(),
        reasoningEffort: this.port.reasoningEffort(),
        ...(this.port.model() ? { modelReference: this.port.modelReference(this.port.model()!) } : {}),
        conversation: [],
      });
      await this.port.restoreStoredSession(replacement, !this.port.explicitModel());
      this.port.refreshTui();
      return this.toSessionView(replacement);
    }
    const active = activeId ? this.port.sessionStore.find(activeId) : undefined;
    if (!active) return undefined;
    this.port.setCurrentSession(active);
    return this.toSessionView(active);
  }

  async createSession(name?: string): Promise<SessionView | undefined> {
    if (this.selection || this.port.interactionRunning() || this.port.hasPendingApprovals()) return undefined;
    await this.port.persistTuiSession();
    const stored = await this.port.sessionStore.create(name, {
      workMode: this.port.workMode(),
      permissionMode: this.port.permissionMode(),
      reasoningEffort: this.port.reasoningEffort(),
      ...(this.port.model() ? { modelReference: this.port.modelReference(this.port.model()!) } : {}),
      conversation: [],
    });
    this.port.setCurrentSession(stored);
    this.port.bumpSessionGeneration();
    this.port.setConversation([]);
    // 新建并挂载会话时清空 once 集合，同时清空通知队列残留。
    this.port.resetHookOnce();
    await this.port.refreshSessionKnowledge();
    this.port.deleteContextManager(stored.id);
    await this.port.ensureCurrentContextManager();
    this.port.setModelWarning(undefined);
    this.port.setPermissionMode(stored.permissionMode ?? (stored.workMode === "plan" ? "plan" : this.port.permissionMode()));
    this.port.setWorkMode(workModeForPermission(this.port.permissionMode()));
    this.port.setReasoningEffort(stored.reasoningEffort ?? "medium");
    this.port.clearFollowUps();
    this.port.clearPendingPlanExecute();
    this.port.setPreviousPlanPermissionMode(undefined);
    this.port.refreshTui();
    return this.toSessionView(stored);
  }

  async renameSession(id: string, name: string): Promise<SessionView | undefined> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) return undefined;
    await this.port.persistTuiSession();
    const stored = await this.port.sessionStore.update(id, { name, autoNamed: false, titleSource: "manual" });
    if (!stored) return undefined;
    if (this.port.currentSession()?.id === stored.id) {
      this.port.setCurrentSession(stored);
      this.port.refreshTui();
    }
    return this.toSessionView(stored);
  }
}
