/**
 * 斜杠命令的执行 handler：权限模式 / 连接向导 / 模型切换 / 会话列表 / 手动压缩。
 * 从 TerminalSession 提取（handlePermissionCommand/changePermissionMode/
 * permissionModeAfterPlan/handleConnect/applyConnectProvider/handleModel/
 * handleSessionCommand/runManualCompaction），行为保持不变。
 * TerminalSession 通过端口提供状态读写与副作用回调；路由层（session-commands.ts）
 * 仍只做解析与分发。
 */
import type { ToolRegistry } from "./tools.js";
import { formatModelReference, modelCandidates } from "./commands.js";
import { loadConfig, loadConfigFile, resolveModelConfig, saveConfig, userConfigReadPath } from "./config.js";
import { formatErrorMessage } from "./error-format.js";
import type { SessionRenderer } from "./renderer.js";
import { configuredPermissionMode, workModeForPermission } from "./session-lifecycle.js";
import type { SessionStore, StoredSession } from "./session-store.js";
import type { ContextManager } from "./context-manager.js";
import type {
  Message,
  ModelConfig,
  ModelProfile,
  ModelProvider,
  PermissionMode,
  ProviderOptions,
  ProviderProfile,
  ReasoningEffort,
  RuntimeEventPayloads,
  UserConfig,
  WorkMode,
} from "./types.js";
import type { ConnectInput, ConnectPrefill, SessionView } from "./tui/types.js";
import type { InkTuiApp } from "./tui/ink-app.js";
import { resolveProviderProtocolFor } from "./provider.js";
import { isAbortError } from "./utils/abort-error.js";
import { isReasoningEffort, PERMISSION_MODES } from "./types.js";

export interface SessionCommandHandlersPort {
  readonly workspace: string;
  renderer(): SessionRenderer;
  tui(): InkTuiApp | undefined;
  config(): UserConfig;
  setConfig(config: UserConfig): void;
  approveAll(): boolean;
  model(): ModelConfig | undefined;
  setModel(model: ModelConfig): void;
  reasoningEffort(): ReasoningEffort;
  setReasoningEffort(value: ReasoningEffort): void;
  permissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  workMode(): WorkMode;
  setWorkMode(mode: WorkMode): void;
  previousPlanPermissionMode(): PermissionMode | undefined;
  setPreviousPlanPermissionMode(mode: PermissionMode | undefined): void;
  clearPendingPlanExecute(): void;
  conversation(): Message[];
  setConversation(messages: Message[]): void;
  currentSessionId(): string | undefined;
  sessionGeneration(): number;
  interactionRunning(): boolean;
  hasPendingApprovals(): boolean;
  refreshTui(): void;
  persistTuiSession(includeTuiSnapshot?: boolean): Promise<void>;
  currentContextManager(): Promise<ContextManager>;
  rememberModelPreference(model: ModelConfig): Promise<void>;
  modelLabel(): string;
  modelWarning(): string | undefined;
  setModelWarning(warning: string | undefined): void;
  selectSession(id: string): Promise<SessionView | undefined>;
  readonly sessionStore: SessionStore;
  sessionName(session: StoredSession): string;
  ensureMcpReady(): Promise<void>;
  registerMcpTools(registry: ToolRegistry): void;
  toolSchemasForCurrentMode(registry: ToolRegistry): Promise<Record<string, unknown>[]>;
  providerFactory(model: ModelConfig): ModelProvider;
  emitContextCompaction(payload: RuntimeEventPayloads["context_compaction"]): Promise<void>;
  compactPromise(): Promise<void> | undefined;
  setCompactPromise(promise: Promise<void> | undefined): void;
  compactAbortController(): AbortController | undefined;
  setCompactAbortController(controller: AbortController | undefined): void;
  setPrompt(): void;
  prompt(): void;
}

export class SessionCommandHandlers {
  constructor(private readonly port: SessionCommandHandlersPort) {}

  async handlePermissionCommand(argument: string): Promise<void> {
    const value = argument.trim().toLowerCase();
    if (!value) {
      this.port
        .renderer()
        .status(`Permission mode: ${this.port.permissionMode()}. Valid modes: ${PERMISSION_MODES.join(", ")}.`, "cyan");
      return;
    }
    if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
      this.port.renderer().error(`invalid permission mode: ${value}; use ${PERMISSION_MODES.join(", ")}`);
      return;
    }
    await this.changePermissionMode(value as PermissionMode);
  }

  async changePermissionMode(mode: PermissionMode): Promise<boolean> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.renderer().status("finish or cancel the current task before changing permission mode", "yellow");
      return false;
    }
    if (mode === "plan" && this.port.permissionMode() !== "plan") {
      this.port.setPreviousPlanPermissionMode(this.port.permissionMode());
      this.port.clearPendingPlanExecute();
    } else if (mode !== "plan" && this.port.permissionMode() === "plan") {
      this.port.setPreviousPlanPermissionMode(undefined);
    }
    if (mode !== this.port.permissionMode()) this.port.clearPendingPlanExecute();
    this.port.setPermissionMode(mode);
    this.port.setWorkMode(workModeForPermission(mode));
    this.port.refreshTui();
    await this.port.persistTuiSession();
    this.port.renderer().status(`Permission mode set to ${mode}.`, "cyan");
    return true;
  }

  permissionModeAfterPlan(): PermissionMode {
    const previous = this.port.previousPlanPermissionMode();
    this.port.setPreviousPlanPermissionMode(undefined);
    if (previous && previous !== "plan") return previous;
    const configured = configuredPermissionMode(this.port.config(), this.port.approveAll());
    return configured === "plan" ? "default" : configured;
  }

  async handleConnect(argument = ""): Promise<void> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.renderer().status("finish or cancel the current task before connecting a provider", "yellow");
      return;
    }
    const tui = this.port.tui();
    if (!tui) {
      this.port.renderer().error("/connect requires the interactive TUI");
      return;
    }
    const name = argument.trim();
    if (!name) {
      await tui.openProviders();
      return;
    }
    // `/connect <provider>`:预填编辑已有 provider,走一遍向导即更新。
    const fresh = await loadConfig(this.port.workspace);
    const profile = fresh.providers[name];
    if (!profile) {
      this.port.renderer().error(`Provider not found: ${name}`);
      return;
    }
    const options = profile.options;
    const prefill: ConnectPrefill = {
      providerName: name,
      baseURL: options.baseUrl ?? "",
      apiKey: options.apiKey ?? "",
      protocol: resolveProviderProtocolFor(name, options),
      models: Object.entries(profile.models).map(([id, item]) => ({
        id,
        ...(isReasoningEffort(item.options.reasoningEffort) ? { reasoningEffort: item.options.reasoningEffort } : {}),
      })),
    };
    await tui.openConnect(prefill);
  }

  /** 从用户级配置删除供应商;项目级配置里的定义不在此范围,删除后会提示。 */
  async handleProviderDelete(name: string): Promise<boolean> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.renderer().status("finish or cancel the current task before deleting a provider", "yellow");
      return false;
    }
    try {
      const configPath = userConfigReadPath();
      const config = await loadConfigFile(configPath);
      if (!config.providers[name]) {
        this.port.renderer().error(`Provider ${name} is not defined in the user config`);
        return false;
      }
      const { [name]: _removed, ...rest } = config.providers;
      config.providers = rest;
      await saveConfig(config, configPath);
      this.port.setConfig(await loadConfig(this.port.workspace));
      const usingIt = this.port.model()?.provider === name;
      this.port
        .renderer()
        .status(`Provider ${name} removed.${usingIt ? " Note: the current model still references it." : ""}`, "cyan");
      return true;
    } catch (error) {
      this.port.renderer().error(formatErrorMessage(error));
      return false;
    }
  }

  async applyConnectProvider(input: ConnectInput): Promise<boolean | void> {
    try {
      const configPath = userConfigReadPath();
      const config = await loadConfigFile(configPath);
      const providerName = input.providerName;
      // 重复 /connect 同名 provider 时合并而非整体覆盖:保留 provider 级与
      // 模型级的手工配置(如 disableReasoningEffort),只刷新连接信息与模型清单。
      const previous = config.providers[providerName];
      const carriedOptions: Record<string, unknown> = { ...previous?.options };
      delete carriedOptions.baseUrl;
      delete carriedOptions.baseURL;
      delete carriedOptions.apiKey;
      delete carriedOptions.protocol;
      const options: Record<string, unknown> = {
        ...carriedOptions,
        baseURL: input.baseURL,
        protocol: input.protocol,
      };
      if (input.apiKey) options.apiKey = input.apiKey;
      const previousModels = previous?.models ?? {};
      const models: Record<string, ModelProfile> = {};
      for (const model of input.models) {
        const modelOptions: Record<string, unknown> = { ...previousModels[model.id]?.options };
        // 向导内 E 指定的 effort 优先;其次沿用旧配置;都没有则按默认 high。
        if (model.reasoningEffort) modelOptions.reasoningEffort = model.reasoningEffort;
        else if (modelOptions.reasoningEffort === undefined) {
          modelOptions.reasoningEffort = input.reasoningEffort ?? "high";
        }
        if (model.contextWindow !== undefined) modelOptions.contextWindow = model.contextWindow;
        models[model.id] = {
          ...(previousModels[model.id]?.name ? { name: previousModels[model.id]!.name } : {}),
          options: modelOptions,
        };
      }
      const profile: ProviderProfile = { options: options as ProviderOptions, models };
      config.providers = { ...config.providers, [providerName]: profile };
      const firstSelectedModel = input.models.find((m) => m.selected) ?? input.models[0];
      await saveConfig(config, configPath);
      this.port.setConfig(await loadConfig(this.port.workspace));
      if (firstSelectedModel) {
        await this.handleModel(`${providerName}/${firstSelectedModel.id}`);
      }
      return true;
    } catch (error) {
      this.port.renderer().error(formatErrorMessage(error));
      return false;
    }
  }

  async handleModel(argument: string): Promise<boolean> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.renderer().status("finish or cancel the current task before changing the model", "yellow");
      return false;
    }
    if (!argument && this.port.tui()) {
      await this.port.tui()!.openModels();
      return true;
    }
    try {
      const fresh = await loadConfig(this.port.workspace);
      const models = modelCandidates(fresh.providers);
      if (!argument) {
        this.port
          .renderer()
          .status(`Available models: ${models.length ? models.join(", ") : "(none configured)"}`, "cyan");
        this.port.renderer().status(`Current model: ${this.port.modelLabel()}.`, "cyan");
        return true;
      }
      const next = resolveModelConfig(fresh, argument);
      this.port.setModel(next);
      this.port.setReasoningEffort(next.reasoningEffort ?? "medium");
      (await this.port.currentContextManager()).resetUsageAnchor();
      this.port.setModelWarning(undefined);
      this.port.renderer().status(`Model set to ${formatModelReference(this.port.model()!)}.`, "cyan");
      this.port.refreshTui();
      await this.port.persistTuiSession();
      await this.port.rememberModelPreference(next);
      return true;
    } catch (error) {
      this.port.renderer().error(formatErrorMessage(error));
      return false;
    }
  }

  async handleSessionCommand(argument = ""): Promise<void> {
    const id = argument.trim();

    if (id) {
      const restored = await this.port.selectSession(id);
      if (restored) {
        this.port.tui()?.restoreSessionView(restored, `Restored session ${restored.id}: ${restored.name}.`);
        if (!this.port.tui()) this.port.renderer().status(`Restored session ${restored.id}: ${restored.name}.`, "cyan");
      } else this.port.renderer().error(`Session not found: ${id}`);
      return;
    }
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.renderer().status("finish or cancel the current task before switching sessions", "yellow");
      return;
    }
    if (this.port.tui()) await this.port.tui()!.openSessions();
    else {
      const sessions = this.port.sessionStore.list();
      const output = sessions.length
        ? `${sessions.map((session) => `${session.id} (${session.archiveMessageCount ?? session.conversation?.length ?? 0} messages) — ${this.port.sessionName(session)}`).join("\n")}\n\nUse /session ID to resume.`
        : "No sessions in this workspace.";
      this.port.renderer().status(output, "cyan");
    }
  }

  async runManualCompaction(): Promise<void> {
    if (this.port.interactionRunning() || this.port.hasPendingApprovals()) {
      this.port.renderer().status("finish or cancel the current interaction before compacting context", "yellow");
      return;
    }
    if (!this.port.model()) {
      this.port.renderer().error("no model selected; use /model PROVIDER/MODEL first");
      return;
    }
    if (!this.port.conversation().length) {
      this.port.renderer().status("No conversation context to compact.", "yellow");
      return;
    }

    await this.port.ensureMcpReady();
    const sessionId = this.port.currentSessionId();
    const sessionGeneration = this.port.sessionGeneration();
    const manager = await this.port.currentContextManager();
    const { ToolRegistry, registerBuiltinTools } = await import("./tools.js");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, this.port.workspace);
    this.port.registerMcpTools(registry);
    const tools = await this.port.toolSchemasForCurrentMode(registry);
    const requestModel: ModelConfig = { ...this.port.model()!, reasoningEffort: this.port.reasoningEffort() };
    const contextWindow = manager.resolveContextWindow(requestModel);
    const beforeTokens = manager.estimateTokens(this.port.conversation(), tools);
    const abortController = new AbortController();
    this.port.setCompactAbortController(abortController);

    const compactPromise = Promise.resolve().then(async (): Promise<void> => {
      await this.port.emitContextCompaction({
        phase: "started",
        reason: "manual",
        beforeTokens,
        replacementCount: 0,
      });
      try {
        const compacted = await manager.compact({
          messages: this.port.conversation(),
          provider: this.port.providerFactory(requestModel),
          tools,
          contextWindow,
          reason: "manual",
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) throw new DOMException("operation aborted", "AbortError");
        if (this.port.sessionGeneration() !== sessionGeneration || this.port.currentSessionId() !== sessionId) {
          throw new Error("active session changed while context compaction was running");
        }
        this.port.setConversation(compacted.messages);
        await this.port.persistTuiSession();
        await this.port.emitContextCompaction({
          phase: "completed",
          reason: "manual",
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          replacementCount: compacted.replacementCount,
        });
      } catch (error) {
        const cancelled = abortController.signal.aborted || isAbortError(error);
        await this.port.emitContextCompaction({
          phase: "failed",
          reason: "manual",
          beforeTokens,
          replacementCount: 0,
          message: cancelled ? "Context compaction cancelled." : formatErrorMessage(error),
        });
      }
    });

    this.port.setCompactPromise(compactPromise);
    this.port.setPrompt();
    this.port.refreshTui();
    try {
      await compactPromise;
    } finally {
      if (this.port.compactPromise() === compactPromise) this.port.setCompactPromise(undefined);
      if (this.port.compactAbortController() === abortController) this.port.setCompactAbortController(undefined);
      this.port.setPrompt();
      this.port.refreshTui();
      this.port.prompt();
    }
  }
}
