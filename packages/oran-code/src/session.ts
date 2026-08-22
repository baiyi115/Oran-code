import { createInterface, type CompleterResult, type Interface } from "node:readline";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { legacyUserHistoryPath, loadConfig, loadConfigFile, resolveModelConfig, saveConfig, userConfigReadPath, userHistoryPath } from "./config.js";
import { CommandRegistry, commandHelp, completeInput, formatModelReference, modelCandidates, parseSlashCommand, type SlashCommand } from "./commands.js";
import { createModelProvider } from "./provider.js";
import { createRuntimeConfig } from "./runtime.js";
import { isAbortError } from "./utils/abort-error.js";
import { TerminalRenderer, createPromptHooks, type SessionRenderer } from "./renderer.js";
import { PERMISSION_MODES, createTask } from "./types.js";
import { displaySessionName, firstConversationPrompt, isAutomaticSessionName, SessionStore, truncateSessionName, type StoredSession } from "./session-store.js";
import type { ApprovalResponse, Message, ModelConfig, ModelProvider, ModelReference, OptionalSystemPromptModules, PermissionMode, ReasoningEffort, RuntimeEvent, RuntimeEventPayloads, SessionTitleMode, Task, ToolCall, ToolDefinition, ToolResult, UserConfig, WorkMode } from "./types.js";
import type { ConnectInput, ConnectModelOption, SessionOption, SessionView, TuiRenderCommitKind } from "./tui/types.js";
import type { ModelProfile, ProviderOptions, ProviderProfile } from "./types.js";
import { WorkspaceFileIndex } from "./tui/composer/file-completion.js";
import { formatErrorMessage } from "./error-format.js";
import { registerDynamicMarkdownCommands } from "./dynamic-commands.js";
import { CommandUsageTracker } from "./command-usage.js";
import { assertSkillTools, registerSkillCommands, renderSkillPrompt, SkillLoader, type SkillDefinition } from "./skills.js";
import { MemoryManager } from "./memory-manager.js";
import type { HookEngine, HookSubAgentExecutor } from "./hook/index.js";
import { CLI_NAME, ensureProjectStateRoot, migrateUserDataOutOfWorkspace, PRODUCT_NAME, projectStateRoot, userTraceRoot } from "./paths.js";
import type { SubagentOrigin } from "./subagent/types.js";
import type { ContextManager } from "./context-manager.js";
import type { TaskController } from "./controller.js";
import type { SqliteTraceStore } from "./trace.js";
import type { ToolRegistry } from "./tools.js";
import type { InkTuiApp } from "./tui/ink-app.js";
import type { MemoryExtractor } from "./memory-extractor.js";
import type { McpManager } from "./mcp/manager.js";
import type { BackgroundAgentTaskManager } from "./subagent/background.js";
import type { AgentDefinitionLoader } from "./subagent/roles.js";
import type { SubagentRunner } from "./subagent/runner.js";
import type { TeamManager } from "./subagent/team.js";
import type { SnapshotStore } from "./snapshot.js";
import type { AgentStateStore } from "./subagent/state-store.js";

const execAsync = promisify(exec);
const SESSION_EXPIRY_DAYS = 30;
const SESSION_GAP_REMINDER_DAYS = 7;

/** Cached dynamic imports so cold-start stays light but first use pays once. */
const loadInkApp = () => import("./tui/ink-app.js");
const loadMcpManager = () => import("./mcp/manager.js");
const loadController = () => import("./controller.js");
const loadHookFacade = () => import("./hook/index.js");
const loadContextManager = () => import("./context-manager.js");
const loadTools = () => import("./tools.js");
const loadTrace = () => import("./trace.js");
const loadMemoryExtractor = () => import("./memory-extractor.js");
const loadProjectInstructionsMod = () => import("./project-instructions.js");
const loadSubagentBackground = () => import("./subagent/background.js");
const loadSubagentAssembly = () => import("./subagent/assembly.js");
const loadSubagentRoles = () => import("./subagent/roles.js");
const loadSubagentTeam = () => import("./subagent/team.js");
const loadSubagentStateStore = () => import("./subagent/state-store.js");
const loadSnapshot = () => import("./snapshot.js");

interface AgentRuntimeServices {
  readonly agentDefinitionLoader: AgentDefinitionLoader;
  readonly agentStateStore: AgentStateStore;
  readonly backgroundAgents: BackgroundAgentTaskManager;
  readonly teams: TeamManager;
  readonly snapshotStore: SnapshotStore;
}

export interface SessionOptions {
  workspace: string;
  model?: ModelConfig;
  config: UserConfig;
  approveAll: boolean;
  providerFactory?: (model: ModelConfig) => ModelProvider;
  stablePromptModules?: OptionalSystemPromptModules;
  onCommandReloadReady?: (reload: () => Promise<void>) => void;
}

interface FollowUpItem {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly workMode: WorkMode;
  readonly permissionMode: PermissionMode;
  readonly createdAt: string;
}

interface PendingApproval {
  readonly call: ToolCall;
  readonly level: number;
  readonly description: string;
  readonly requestId: string;
  readonly origin: SubagentOrigin;
  readonly resolve: (response: ApprovalResponse) => void;
  presented: boolean;
  settled: boolean;
}

interface ActiveSkill {
  readonly definition: SkillDefinition;
  readonly prompt: string;
}

/**
 * Owns the interactive lifecycle while TaskController owns agent behavior.
 * Keeping this boundary explicit makes the same runtime usable from Desktop.
 */
export class TerminalSession {
  private workspace: string;
  private model: ModelConfig | undefined;
  private readonly explicitModel: boolean;
  private conversation: Message[] = [];
  private readonly contextManagers = new Map<string, ContextManager>();
  private modelWarning: string | undefined;
  private config: UserConfig;
  private approveAll: boolean;
  private skipVerify: boolean;
  private renderer: SessionRenderer;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WriteStream;
  private readline: Interface | undefined;
  private trace: SqliteTraceStore | undefined;
  private traceOpen: Promise<void> | undefined;
  private controller: TaskController | undefined;
  private taskPromise: Promise<Task | undefined> | undefined;
  private shellPromise: Promise<void> | undefined;
  private shellAbortController: AbortController | undefined;
  private compactPromise: Promise<void> | undefined;
  private compactAbortController: AbortController | undefined;
  private previousToolHistory: ToolCall[] = [];
  private previousReadonlyResults?: ReadonlyMap<string, ToolResult>;
  private contextEventSequence = 0;
  private readonly pendingApprovals: PendingApproval[] = [];
  private workMode: WorkMode;
  private permissionMode: PermissionMode;
  private reasoningEffort: ReasoningEffort;
  private sessionStore: SessionStore;
  private readonly workspaceFileIndex: WorkspaceFileIndex;
  private currentSession: StoredSession | undefined;
  private readonly followUps: FollowUpItem[] = [];
  /** Plan completed in plan mode and is waiting for an explicit user decision. */
  private pendingPlanExecute: { sessionId: string; plan: string; prompt: string } | undefined;
  private previousPlanPermissionMode: PermissionMode | undefined;
  private queuePaused = false;
  private sessionSave: Promise<void> = Promise.resolve();
  private debugLogTail: Promise<void> = Promise.resolve();
  private sessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly titleJobs = new Set<Promise<void>>();
  private readonly titleAbortControllers = new Set<AbortController>();
  private sessionSaveError: string | undefined;
  private sessionGeneration = 0;
  private taskGeneration = 0;
  private quitRequested = false;
  private inputEnded = false;
  private readlineClosed = false;
  private tui: InkTuiApp | undefined;
  private readonly providerFactory: (model: ModelConfig) => ModelProvider;
  private stablePromptModules: OptionalSystemPromptModules;
  private readonly configuredStablePromptModules: OptionalSystemPromptModules;
  private readonly memoryManager: MemoryManager;
  private memoryExtractor: MemoryExtractor | undefined;
  private memoryExtractorInit: Promise<MemoryExtractor> | undefined;
  private readonly memoryExtractionJobs = new Set<Promise<void>>();
  private memoryExtractorModelKey: string | undefined;
  private readonly memorySnapshots = new Map<string, string>();
  private readonly pendingMemorySnapshots = new Map<string, string>();
  private sessionSelection: Promise<SessionView | undefined> | undefined;
  private commandRegistry = new CommandRegistry();
  private readonly skillLoader: SkillLoader;
  private readonly activeSkills = new Map<string, ActiveSkill>();
  private readonly configuredActiveSkills: string | undefined;
  private commandUsage: CommandUsageTracker | undefined;
  private commandIntegrationPromise: Promise<void> | undefined;
  private latestUsage: Record<string, number> = {};
  private readonly debugStreamSequences = new Map<string, number>();
  private readonly debugStreamTurns = new Map<string, { deltaEvents: number; deltaChars: number }>();
  private hookEngine: HookEngine | undefined;
  private hookWarningsShown = false;
  private readonly hookSubagentAbortControllers = new Set<AbortController>();
  private readonly hookSubagentJobs = new Set<Promise<void>>();
  private mcpManager: McpManager | undefined;
  private mcpReady: Promise<void> | undefined;
  private mcpFailuresShown = false;
  private agentRuntime: AgentRuntimeServices | undefined;
  private agentRuntimePromise: Promise<AgentRuntimeServices> | undefined;
  private agentStateRestore: Promise<void> | undefined;

  constructor(options: SessionOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WriteStream = process.stdout) {
    this.workspace = resolve(options.workspace);
    this.explicitModel = options.model !== undefined;
    this.model = options.model ?? resolveRememberedModel(options.config);
    this.config = options.config;
    this.approveAll = options.approveAll;
    this.permissionMode = configuredPermissionMode(options.config, options.approveAll);
    this.workMode = workModeForPermission(this.permissionMode);
    this.reasoningEffort = this.model?.reasoningEffort ?? "medium";
    this.sessionStore = new SessionStore(this.workspace);
    this.workspaceFileIndex = new WorkspaceFileIndex(this.workspace);
    this.skipVerify = options.config.agent?.skipVerify === true;
    this.input = input;
    this.output = output;
    this.renderer = new TerminalRenderer(output);
    this.providerFactory = options.providerFactory ?? ((model: ModelConfig) => createModelProvider(model));
    this.configuredStablePromptModules = { ...options.stablePromptModules };
    this.stablePromptModules = { ...this.configuredStablePromptModules };
    this.memoryManager = new MemoryManager(this.workspace);
    this.skillLoader = new SkillLoader(this.workspace);
    this.configuredActiveSkills = options.stablePromptModules?.activeSkills;
    options.onCommandReloadReady?.(() => this.reloadCommands());
  }

  /** Lazily construct subagent/snapshot services so interactive cold start skips that module graph. */
  private async ensureAgentRuntime(): Promise<AgentRuntimeServices> {
    if (this.agentRuntime) return this.agentRuntime;
    this.agentRuntimePromise ??= (async () => {
      const [
        { AgentDefinitionLoader },
        { AgentStateStore },
        { BackgroundAgentTaskManager },
        { TeamManager },
        { SnapshotStore },
      ] = await Promise.all([
        loadSubagentRoles(),
        loadSubagentStateStore(),
        loadSubagentBackground(),
        loadSubagentTeam(),
        loadSnapshot(),
      ]);
      const agentStateStore = new AgentStateStore(this.workspace);
      const runtime: AgentRuntimeServices = {
        agentDefinitionLoader: new AgentDefinitionLoader(this.workspace),
        agentStateStore,
        backgroundAgents: new BackgroundAgentTaskManager(agentStateStore, () => this.flushBackgroundNotifications()),
        teams: new TeamManager(agentStateStore),
        snapshotStore: new SnapshotStore(this.workspace),
      };
      this.agentRuntime = runtime;
      return runtime;
    })();
    return this.agentRuntimePromise;
  }

  async run(): Promise<void> {
    if (!existsSync(this.workspace)) throw new Error(`workspace does not exist: ${this.workspace}`);
    await ensureProjectStateRoot(this.workspace);
    // First paint only needs history + a blank session. Heavy integrations load in the background.
    const [history] = await Promise.all([
      loadHistory(),
      this.openSessionStore(),
    ]);
    void this.ensureAgentStateRestored().catch((error) => this.writeDebugLog(`agent state restore failed: ${String(error)}`));
    void this.initializeCommandIntegrations().then(() => this.refreshTui()).catch((error) => this.writeDebugLog(`command integrations failed: ${String(error)}`));
    void this.openTrace().catch((error) => this.writeDebugLog(`trace open failed: ${String(error)}`));
    const isTty = supportsTui(this.input, this.output);
    if (isTty) {
      try {
        await this.runTui(history);
      } finally {
        await this.shutdown();
      }
      return;
    }
    this.readline = createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean((this.input as NodeJS.ReadStream).isTTY && this.output.isTTY),
      historySize: 1000,
      removeHistoryDuplicates: true,
      completer: (line, callback) => this.complete(line, callback),
    });
    this.inputEnded = false;
    this.readlineClosed = false;
    this.readline.on("close", () => {
      this.inputEnded = true;
      this.readlineClosed = true;
    });
    restoreHistory(this.readline, history);
    this.renderer.attachPrompt(createPromptHooks(this.output, () => this.prompt()));
    this.setPrompt();
    this.renderer.status(`${PRODUCT_NAME} ${this.modelLabel()} | ${this.workspace}`, "boldCyan");
    this.renderer.status("Type / for commands or !command for a shell command.");
    this.startMcpConnections();
    this.prompt();

    try {
      for await (const value of this.readline) {
        await this.handleInput(value);
        if (this.quitRequested || this.inputEnded) {
          break;
        }
        this.prompt();
      }
      await this.waitForTask();
    } finally {
      await this.shutdown();
    }
  }

  async runOnce(prompt: string): Promise<Task> {
    if (!existsSync(this.workspace)) throw new Error(`workspace does not exist: ${this.workspace}`);
    await ensureProjectStateRoot(this.workspace);
    await Promise.all([
      this.ensureAgentStateRestored(),
      this.initializeCommandIntegrations(),
      this.openTrace(),
      this.openSessionStore(),
    ]);
    this.startMcpConnections();
    try {
      return await this.startTask(prompt, false, false, undefined, true);
    } finally {
      await this.shutdown();
    }
  }

  async handleInput(value: string): Promise<void> {
    const input = value.trim();
    if (!input) return;

    if (this.pendingPlanExecute) {
      await this.resolvePendingPlan(input);
      return;
    }

    if (input.startsWith("/")) {
      // Dynamic/skills commands may still be scanning after first paint.
      await this.initializeCommandIntegrations();
      await this.handleCommand(input);
      return;
    }

    await this.submitUserPrompt(input);
  }

  /** Reloads newly installed user commands and skills without restarting the TUI. */
  async reloadCommands(): Promise<void> {
    await this.initializeCommandIntegrations();
    await this.loadCommandRegistry();
    this.refreshTui();
  }

  private async submitUserPrompt(input: string): Promise<void> {
    if (this.hasPendingApprovals()) {
      if (isApprovalAnswer(input)) this.resolveApproval(input);
      else if (input.startsWith("!")) this.renderer.error("finish or cancel the current task before running a shell command");
      else this.enqueueFollowUp(input);
      return;
    }

    if (input.startsWith("!")) {
      await this.runShell(input.slice(1).trim());
    } else if (this.taskRunning()) {
      this.enqueueFollowUp(input);
    } else if (this.shellRunning()) {
      this.renderer.error("finish the current shell command before submitting another input");
    } else if (this.compactRunning()) {
      this.renderer.error("wait for or cancel context compaction before submitting another input");
    } else if (!this.model) {
      this.renderer.error("no model selected; use /model PROVIDER/MODEL first");
    } else {
      this.renderer.user(input);
      this.setPrompt();
      this.launchTask(input, true);
    }
  }

  /** 首次需要时构造 Hook 引擎，并为当前任务绑定 Subagent Runner。 */
  private async ensureHookEngine(runner: SubagentRunner): Promise<HookEngine | undefined> {
    const runtime = await this.ensureAgentRuntime();
    const subAgentExecutor: HookSubAgentExecutor = async (prompt, context) => {
      const definition = runtime.agentDefinitionLoader.get("general");
      const abortController = new AbortController();
      this.hookSubagentAbortControllers.add(abortController);
      const run = runner.run({
        description: `hook-${context.event}`,
        prompt,
        origin: { kind: "hook", name: context.event },
        ...(definition ? { definition } : {}),
        customDeniedTools: ["agent"],
        abortController,
      });
      const job = run.then(() => undefined, () => undefined);
      this.hookSubagentJobs.add(job);
      try {
        const result = await run;
        return {
          output: result.output,
          ok: result.status === "completed",
          intercept: false,
        };
      } finally {
        this.hookSubagentAbortControllers.delete(abortController);
        this.hookSubagentJobs.delete(job);
      }
    };
    if (this.hookEngine) {
      this.hookEngine.setSessionMessages(() => this.conversation);
      this.hookEngine.setSubAgentExecutor(subAgentExecutor);
      return this.hookEngine;
    }
    try {
      const { createHookEngine } = await loadHookFacade();
      const built = await createHookEngine(this.workspace, {
        defaultCommandTimeoutMs: 60_000,
        log: (message) => { try { this.renderer.status(message); } catch { /* ignore */ } },
        sessionMessages: () => this.conversation,
        subAgentExecutor,
      });
      this.hookEngine = built.engine;
      // 校验错误聚合后通过会话系统提示一次性呈现
      if (!this.hookWarningsShown && built.errors.length) {
        this.hookWarningsShown = true;
        const lines = built.errors.map((e) => `Hook 配置警告：#${e.index}${e.id ? ` (${e.id})` : ""} ${e.message}`);
        this.renderer.error(lines.join("\n"));
        // 校验错误通过会话内系统提示消息呈现给模型，前缀固定为 "Hook 配置警告："。
        this.conversation.push({
          role: "system",
          content: lines.join("\n"),
          metadata: { promptBlock: "hook-warning", contextManaged: true },
        });
      }
      return this.hookEngine;
    } catch (error) {
      this.renderer.error(`Hook 引擎初始化失败：${formatErrorMessage(error)}`);
      return undefined;
    }
  }

  private async startTask(
    prompt: string,
    printErrors: boolean,
    isolated = false,
    derivedSkill?: SkillDefinition,
    joinStructuredForks = false,
  ): Promise<Task> {
    if (this.shellRunning()) throw new Error("finish the current shell command before starting a task");
    if (this.compactRunning()) throw new Error("wait for or cancel context compaction before starting a task");
    this.taskGeneration += 1;
    if (!this.model) {
      const error = new Error("no model selected; use /model PROVIDER/MODEL first");
      if (printErrors) this.renderer.error(error.message);
      throw error;
    }
    if (!isolated) await this.persistQueuedUserMessage(prompt);
    await Promise.all([
      this.ensureMcpReady(),
      this.openTrace(),
      this.initializeCommandIntegrations(),
    ]);
    const [
      agentRuntime,
      { ToolRegistry, registerBuiltinTools },
      { assembleSubagentStack, joinStructuredForkSummaries, disposeStructuredScope },
      { backgroundTaskNotification },
      { TaskController },
      { ContextManager },
      { createHookEngine },
    ] = await Promise.all([
      this.ensureAgentRuntime(),
      loadTools(),
      loadSubagentAssembly(),
      loadSubagentBackground(),
      loadController(),
      loadContextManager(),
      loadHookFacade(),
    ]);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, this.workspace);
    this.registerMcpTools(registry);
    this.registerSkillSystemTools(registry);
    if (derivedSkill) assertSkillTools(derivedSkill, registry.list().map((tool) => tool.name));
    const selectedModel = derivedSkill?.model
      ? resolveModelConfig(this.config, derivedSkill.model)
      : this.model;
    const requestModel: ModelConfig = { ...selectedModel, reasoningEffort: this.reasoningEffort };
    const runtimeConfig = createRuntimeConfig(this.workspace, requestModel, this.config, this.approveAll, this.workMode, this.permissionMode);
    runtimeConfig.skipVerify = this.skipVerify;
    const trace = this.trace;
    if (!trace) throw new Error("trace store is not initialized");
    const sessionId = this.currentSession?.id;
    const sessionGeneration = this.sessionGeneration;
    const taskGeneration = this.taskGeneration;
    const derivedConversation = derivedSkill ? this.derivedSkillConversation(derivedSkill) : [];
    const parentToolFilter = (tool: ToolDefinition): boolean => {
      if (this.mcpManager?.isMcpTool(tool.name) && !this.mcpManager.isActivated(tool.name)) return false;
      return derivedSkill
        ? derivedSkill.allowedTools.length === 0 || derivedSkill.allowedTools.includes(tool.name)
        : this.isToolAllowedByActiveSkills(tool.name);
    };
    const { runner, scope: structuredScope } = assembleSubagentStack({
      roles: agentRuntime.agentDefinitionLoader,
      background: agentRuntime.backgroundAgents,
      teams: agentRuntime.teams,
      registry,
      runnerDeps: {
        workspace: this.workspace,
        registry,
        trace,
        baseConfig: runtimeConfig,
        baseModel: requestModel,
        providerFactory: this.providerFactory,
        resolveModel: (reference) => resolveModelConfig(this.config, reference),
        approvalCallback: (call, level, description, requestId, origin) => (
          this.requestApproval(call, level, description, origin, requestId)
        ),
        approvalCancellationCallback: (origin) => this.cancelApprovalsForOrigin(origin),
        parentToolFilter,
        isMcpTool: (name) => this.mcpManager?.isMcpTool(name) === true,
        hookFactory: async (workspace, messages) => {
          const built = await createHookEngine(workspace, {
            defaultCommandTimeoutMs: 60_000,
            sessionMessages: messages,
          });
          return built.engine;
        },
      },
      joinStructuredForks,
      forkWaitTimeoutMs: runtimeConfig.subagent.forkWaitTimeoutMs,
      parentConversation: () => isolated ? derivedConversation : this.conversation,
      resolveModel: (reference) => resolveModelConfig(this.config, reference),
    });
    const hookEngine = await this.ensureHookEngine(runner);
    const consumedBackgroundNotifications: string[] = [];
    const controller = new TaskController({
      config: runtimeConfig,
      provider: this.providerFactory(requestModel),
      registry,
      trace,
      conversation: isolated ? derivedConversation : this.conversation,
      contextManager: isolated
        ? new ContextManager({ workspace: this.workspace, conversation: derivedConversation })
        : await this.currentContextManager(),
      approvalCallback: (call, level, description, requestId) => (
        this.requestApproval(call, level, description, { kind: "main" }, requestId)
      ),
      eventCallback: (event) => this.onEvent(event),
      ...(!isolated ? {
        conversationCallback: (messages: readonly Message[]) => {
          if (this.sessionGeneration !== sessionGeneration || this.taskGeneration !== taskGeneration || this.currentSession?.id !== sessionId) return;
          this.conversation = [...structuredClone(messages)];
          this.scheduleTuiSessionPersist();
        },
      } : {}),
      stablePromptModules: this.stablePromptModules,
      runtimeReminders: () => {
        const reminders = derivedSkill
          ? [this.formatActiveSkillReminder(derivedSkill.name, renderSkillPrompt(derivedSkill))]
          : this.activeSkillReminders();
        const notifications = agentRuntime.backgroundAgents.drainNotifications().map(backgroundTaskNotification);
        consumedBackgroundNotifications.push(...notifications);
        return [...reminders, ...notifications];
      },
      toolFilter: parentToolFilter,
      ...(hookEngine ? { hookEngine } : {}),
      hookUserPrompt: prompt,
      previousToolCalls: this.previousToolHistory,
      ...(this.previousReadonlyResults !== undefined ? { previousReadonlyResults: this.previousReadonlyResults } : {}),
      debugLogger: (message) => this.writeDebugLog(message),
      ...(sessionId ? { snapshotStore: agentRuntime.snapshotStore, snapshotSessionId: sessionId } : {}),
    });
    this.controller = controller;
    let completed = false;
    try {
      const initialTask = createTask(this.workspace, prompt);
      if (this.currentSession?.planState) {
        initialTask.planState = structuredClone(this.currentSession.planState);
      }
      const task = await controller.execute(initialTask);
      if (task.planState && this.currentSession) {
        this.currentSession.planState = structuredClone(task.planState);
      }
      if (structuredScope) {
        await joinStructuredForkSummaries(structuredScope, task, runtimeConfig.subagent.forkWaitTimeoutMs);
      }
      completed = task.state === "completed";
      if (task.state === "completed") this.renderer.status("Task completed.", "green");
      else if (task.state !== "cancelled") this.renderer.status(`Task ${task.state}.`, "yellow");
      return task;
    } catch (error) {
      // Runtime already appends a concise error event to the transcript. Only
      // print a second copy for non-TUI paths that may not have rendered it.
      if (printErrors && !this.tui) this.renderer.error(formatErrorMessage(error));
      throw error;
    } finally {
      if (structuredScope) await disposeStructuredScope(structuredScope);
      if (this.controller === controller) this.controller = undefined;
      const conversationSnapshot = controller.conversationSnapshot();
      consumedBackgroundNotifications.push(
        ...agentRuntime.backgroundAgents.drainNotifications().map(backgroundTaskNotification),
      );
      for (const notification of consumedBackgroundNotifications) {
        conversationSnapshot.push({
          role: "system",
          content: notification,
          metadata: { promptBlock: "task-notification", contextManaged: true },
        });
      }
      this.previousToolHistory = controller.toolCallHistory;
      this.previousReadonlyResults = controller.readonlyResultSnapshot;
      if (!isolated) this.conversation = conversationSnapshot;
      this.taskGeneration += 1;
      await this.persistTuiSession();
      if (!isolated && completed && sessionId) {
        this.scheduleModelSessionTitle(sessionId, requestModel);
        this.scheduleMemoryExtraction(sessionId, conversationSnapshot, requestModel);
      }
    }
  }

  private async persistQueuedUserMessage(prompt: string): Promise<void> {
    const sessionId = this.currentSession?.id;
    if (!sessionId) return;
    const message: Message = { role: "user", content: `User message:\n${prompt}` };
    try {
      const updated = await this.sessionStore.appendMessage(sessionId, message);
      if (updated && this.currentSession?.id === sessionId) this.currentSession = updated;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (this.sessionSaveError !== messageText) {
        this.sessionSaveError = messageText;
        this.renderer.error(`Session save failed:\n${formatErrorMessage(error)}`);
      }
    }
  }

  private launchTask(prompt: string, printErrors: boolean, queued = false, isolated = false, derivedSkill?: SkillDefinition): void {
    if (queued) this.renderer.user(prompt, true);
    this.taskPromise = this.startTask(prompt, printErrors, isolated, derivedSkill)
      .catch((error) => {
        if (printErrors) return undefined as unknown as Task;
        throw error;
      })
      .finally(async () => {
        this.taskPromise = undefined;
        this.queuePaused = false;
        this.setPrompt();
        this.refreshTui();
        void this.persistTuiSession();
        await this.drainFollowUps();
        this.prompt();
      });
  }

  private enqueueFollowUp(prompt: string): void {
    const item: FollowUpItem = {
      id: `follow-up-${Date.now()}-${this.followUps.length + 1}`,
      sessionId: this.currentSession?.id ?? "session-current",
      prompt,
      workMode: this.workMode,
      permissionMode: this.permissionMode,
      createdAt: new Date().toISOString(),
    };
    this.followUps.push(item);
    this.renderer.user(prompt, true);
    this.renderer.status(`queued follow-up (${this.followUps.length})`, "cyan");
    this.refreshTui();
  }


  private async resolvePendingPlan(input: string): Promise<boolean> {
    const pending = this.pendingPlanExecute;
    const sessionId = this.currentSession?.id ?? "session-current";
    if (!pending || pending.sessionId !== sessionId || this.taskRunning() || this.hasPendingApprovals()) return false;
    const answer = input.trim().toLowerCase();
    if (answer === "n" || answer === "no" || answer === "esc" || answer === "") {
      this.pendingPlanExecute = undefined;
      this.renderer.status("Plan discarded.", "cyan");
      this.refreshTui();
      await this.persistTuiSession();
      await this.drainFollowUps();
      return true;
    }
    if (answer !== "y" && answer !== "yes") {
      this.renderer.status("Reply y to execute the plan or n to discard it.", "yellow");
      return false;
    }
    this.pendingPlanExecute = undefined;
    if (!this.model) {
      this.renderer.error("plan execution skipped: no model selected");
      return false;
    }
    this.renderer.status("Executing plan...", "cyan");
    this.launchTask(pending.prompt, true);
    return true;
  }

  private async drainFollowUps(): Promise<void> {
    if (this.queuePaused || this.taskRunning() || this.hasPendingApprovals() || this.pendingPlanExecute || this.quitRequested) return;
    const sessionId = this.currentSession?.id ?? "session-current";
    let next: FollowUpItem | undefined;
    while (this.followUps.length) {
      const candidate = this.followUps.shift();
      if (candidate?.sessionId === sessionId) {
        next = candidate;
        break;
      }
    }
    if (!next) return;
    if (!this.model) {
      this.renderer.error("queued message skipped: no model selected");
      return void this.drainFollowUps();
    }
    this.permissionMode = next.permissionMode;
    this.workMode = workModeForPermission(this.permissionMode);
    this.launchTask(next.prompt, true);
  }

  private refreshTui(): void {
    this.tui?.refreshContext();
  }

  private async initializeCommandIntegrations(): Promise<void> {
    if (!this.commandIntegrationPromise) {
      this.commandIntegrationPromise = (async () => {
        const runtime = await this.ensureAgentRuntime();
        const [commandUsage] = await Promise.all([
          CommandUsageTracker.load(this.workspace),
          runtime.agentDefinitionLoader.scan(),
          this.loadCommandRegistry(),
        ]);
        this.commandUsage = commandUsage;
      })();
    }
    await this.commandIntegrationPromise;
  }

  private async loadCommandRegistry(): Promise<void> {
    const registry = new CommandRegistry();
    await registerDynamicMarkdownCommands(registry, { workspace: this.workspace });
    await registerSkillCommands(registry, this.skillLoader);
    this.commandRegistry = registry;
    const activeSkills = this.configuredActiveSkills;
    const { activeSkills: _previousSkills, ...remainingModules } = this.stablePromptModules;
    this.stablePromptModules = activeSkills ? { ...remainingModules, activeSkills } : remainingModules;
  }

  private commandSnapshot(): SlashCommand[] {
    const commands = this.commandRegistry.list();
    const byName = new Map(commands.map((command) => [command.name, command]));
    const recent = (this.commandUsage?.recent(5) ?? [])
      .map((entry) => byName.get(entry.name))
      .filter((command): command is SlashCommand => command !== undefined);
    const recentNames = new Set(recent.map((command) => command.name));
    return [
      ...recent,
      ...commands.filter((command) => !recentNames.has(command.name)),
    ];
  }

  private async currentContextManager(): Promise<ContextManager> {
    const session = this.currentSession;
    if (!session) throw new Error("session context is not initialized");
    let manager = this.contextManagers.get(session.id);
    if (!manager) {
      const { ContextManager } = await loadContextManager();
      manager = new ContextManager({ workspace: this.workspace, conversation: this.conversation });
      this.contextManagers.set(session.id, manager);
    }
    return manager;
  }

  private async refreshSessionKnowledge(): Promise<void> {
    const { loadProjectInstructions } = await loadProjectInstructionsMod();
    const [projectInstructions, memorySummary] = await Promise.all([
      loadProjectInstructions({ workspace: this.workspace }).catch(() => ""),
      this.memoryManager.buildSummary().catch(() => ""),
    ]);
    const discoveredInstructions = [
      `Current date: ${new Date().toISOString().slice(0, 10)}`,
      projectInstructions,
    ].filter((section) => section.trim()).join("\n\n");
    const customInstructions = [
      discoveredInstructions,
      this.configuredStablePromptModules.customInstructions,
    ].filter((section): section is string => Boolean(section?.trim())).join("\n\n---\n\n");
    const longTermMemory = [
      memorySummary,
      this.configuredStablePromptModules.longTermMemory,
    ].filter((section): section is string => Boolean(section?.trim())).join("\n\n---\n\n");
    const {
      customInstructions: _configuredInstructions,
      longTermMemory: _configuredMemory,
      ...remainingModules
    } = this.configuredStablePromptModules;
    this.stablePromptModules = {
      ...remainingModules,
      ...(customInstructions ? { customInstructions } : {}),
      ...(longTermMemory ? { longTermMemory } : {}),
    };
  }

  private async openSessionStore(): Promise<void> {
    this.sessionStore = new SessionStore(this.workspace);
    await this.sessionStore.open();
    await this.sessionStore.cleanExpired(SESSION_EXPIRY_DAYS).catch(() => 0);
    // Cold start always opens a blank conversation. Previous chats remain available
    // via /session; they are no longer auto-restored into a new process. Reuse an
    // existing disposable blank session so restarting the CLI does not accumulate
    // indistinguishable "Current session · 0 msgs" entries.
    const reusable = this.sessionStore.list().find(isReusableBlankSession);
    const defaults = {
      workMode: this.workMode,
      permissionMode: this.permissionMode,
      reasoningEffort: this.reasoningEffort,
      ...(this.model ? { modelReference: this.modelReference(this.model) } : {}),
      conversation: [],
    };
    const stored = reusable
      ? await this.sessionStore.update(reusable.id, {
          name: "Current session",
          autoNamed: true,
          titleSource: "local",
          titleGenerationAttempted: false,
          ...defaults,
          ...(!this.model ? { modelReference: null } : {}),
        }) ?? await this.sessionStore.create("Current session", defaults)
      : await this.sessionStore.create("Current session", defaults);
    await this.restoreStoredSession(stored, !this.explicitModel);
  }

  private async restoreStoredSession(stored: StoredSession, restoreModel: boolean): Promise<void> {
    this.sessionGeneration += 1;
    // 重新挂载会话时清空 once 集合，并丢弃上一任务遗留的通知。
    this.hookEngine?.resetOnce();
    this.hookEngine?.drainNotices();
    this.currentSession = structuredClone(stored);
    this.previousPlanPermissionMode = undefined;
    this.permissionMode = stored.permissionMode
      ?? (stored.workMode === "plan" ? "plan" : configuredPermissionMode(this.config, this.approveAll));
    this.workMode = workModeForPermission(this.permissionMode);
    this.reasoningEffort = stored.reasoningEffort ?? this.model?.reasoningEffort ?? "medium";
    this.modelWarning = undefined;

    if (restoreModel && !this.explicitModel) {
      if (!stored.modelReference) {
        this.model = undefined;
      } else {
        try {
          const config = await loadConfig(this.workspace);
          this.model = resolveModelConfig(config, `${stored.modelReference.provider}/${stored.modelReference.model}`);
        } catch {
          this.model = undefined;
          this.modelWarning = "Saved model provider/model is unavailable; choose another model with /model.";
        }
      }
    }

    await this.refreshSessionKnowledge();
    this.contextManagers.delete(stored.id);
    this.conversation = structuredClone(stored.conversation ?? [])
      .filter((message) => message.metadata?.promptBlock !== "session-gap-reminder");
    const gapReminder = createSessionGapReminder(stored.updatedAt);
    if (gapReminder) this.conversation.unshift(gapReminder);
    const manager = await this.currentContextManager();
    await this.compactRestoredConversation(manager);
    if (this.currentSession) this.currentSession.conversation = structuredClone(this.conversation);
    if (this.model) await this.rememberModelPreference(this.model);
  }

  private async compactRestoredConversation(manager: ContextManager): Promise<void> {
    if (!this.model || !this.conversation.length) return;
    const { ToolRegistry, registerBuiltinTools } = await loadTools();
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, this.workspace);
    if (this.mcpManager) {
      await this.ensureMcpReady();
      this.registerMcpTools(registry);
    }
    const tools = await this.toolSchemasForCurrentMode(registry);
    const requestModel: ModelConfig = { ...this.model, reasoningEffort: this.reasoningEffort };
    const contextWindow = manager.resolveContextWindow(requestModel);
    if (!manager.shouldAutoCompact(this.conversation, contextWindow, tools)) return;
    try {
      const compacted = await manager.compact({
        messages: this.conversation,
        provider: this.providerFactory(requestModel),
        tools,
        contextWindow,
        reason: "auto",
      });
      this.conversation = compacted.messages;
    } catch {
      // A failed recovery compaction must not make an otherwise readable session unusable.
    }
  }

  private modelReference(model: ModelConfig): ModelReference {
    return { provider: model.provider, model: model.model };
  }

  private async rememberModelPreference(model: ModelConfig): Promise<void> {
    const reference = formatModelReference(model);
    try {
      const userConfig = await loadConfigFile(userConfigReadPath());
      if (userConfig.agent?.lastModel !== reference) {
        userConfig.agent = { ...userConfig.agent, lastModel: reference };
        await saveConfig(userConfig);
      }
      this.config = {
        ...this.config,
        agent: { ...this.config.agent, lastModel: reference },
      };
    } catch (error) {
      this.modelWarning ??= `Could not remember the selected model: ${formatErrorMessage(error)}`;
    }
  }

  private async persistTuiSession(includeTuiSnapshot = true): Promise<void> {
    if (this.sessionPersistTimer) {
      clearTimeout(this.sessionPersistTimer);
      this.sessionPersistTimer = undefined;
    }
    const session = this.currentSession;
    if (!session) return;
    const view = includeTuiSnapshot ? this.tui?.sessionSnapshot() : undefined;
    const modelReference = this.model ? this.modelReference(this.model) : session.modelReference;
    const sessionId = session.id;
    const sessionGeneration = this.sessionGeneration;
    const taskGeneration = this.taskGeneration;
    const conversation = structuredClone(this.conversation.filter((message) => message.metadata?.promptBlock !== "session-gap-reminder"));
    this.sessionSave = this.sessionSave.then(async () => {
      try {
        if (this.sessionGeneration !== sessionGeneration || this.taskGeneration !== taskGeneration || this.currentSession?.id !== sessionId) return;
        const latest = this.sessionStore.find(sessionId) ?? session;
        const autoNamed = isAutomaticSessionName(latest);
        const titleSource = latest.titleSource ?? (autoNamed ? "local" : "manual");
        const name = displaySessionName({
          name: titleSource === "local" ? view?.name ?? latest.name : latest.name,
          messages: view?.messages ?? latest.messages,
          autoNamed,
          titleSource,
          ...(latest.archiveTitle ? { archiveTitle: latest.archiveTitle } : {}),
        }, this.sessionTitleMode());
        const updated = await this.sessionStore.update(sessionId, {
          ...(view ? { name, autoNamed, titleSource, messages: view.messages, history: view.history } : { name, autoNamed, titleSource }),
          workMode: view?.workMode ?? this.workMode,
          permissionMode: view?.permissionMode ?? this.permissionMode,
          reasoningEffort: view?.reasoningEffort ?? this.reasoningEffort,
          ...(modelReference ? { modelReference } : {}),
          ...(this.currentSession?.planState !== undefined ? { planState: this.currentSession.planState } : {}),
          conversation,
        });
        if (updated && this.currentSession?.id === sessionId && this.sessionGeneration === sessionGeneration) {
          const nameChanged = this.currentSession.name !== updated.name;
          this.currentSession = updated;
          if (nameChanged) this.refreshTui();
        }
        this.sessionSaveError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.sessionSaveError !== message) {
          this.sessionSaveError = message;
          this.renderer.error(`Session save failed:\n${formatErrorMessage(error)}`);
        }
      }
    });
    await this.sessionSave;
  }

  private async loadSessionOptions(): Promise<SessionOption[]> {
    await this.persistTuiSession();
    return this.sessionStore.list().map((session) => ({
      id: session.id,
      name: this.sessionName(session),
      updatedAt: session.updatedAt,
      messageCount: session.archiveMessageCount ?? session.conversation?.length ?? session.messages.length,
      isCurrent: session.id === this.currentSession?.id,
    }));
  }

  private toSessionView(session: StoredSession): SessionView {
    const activeModelReference = this.currentSession?.id === session.id && this.model
      ? this.modelReference(this.model)
      : session.modelReference;
    return {
      id: session.id,
      name: this.sessionName(session),
      messages: session.messages,
      history: session.history,
      ...(session.workMode !== undefined ? { workMode: session.workMode } : {}),
      ...(session.permissionMode !== undefined ? { permissionMode: session.permissionMode } : {}),
      ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(activeModelReference !== undefined ? { modelReference: { ...activeModelReference } } : {}),
      ...(session.conversation !== undefined ? { conversation: structuredClone(session.conversation) } : {}),
      ...(this.currentSession?.id === session.id && this.modelWarning ? { modelWarning: this.modelWarning } : {}),
    };
  }

  private async selectSession(id: string): Promise<SessionView | undefined> {
    if (this.sessionSelection) return this.sessionSelection;
    let selection: Promise<SessionView | undefined>;
    selection = this.selectSessionUnlocked(id).finally(() => {
      if (this.sessionSelection === selection) this.sessionSelection = undefined;
    });
    this.sessionSelection = selection;
    return selection;
  }

  private async selectSessionUnlocked(id: string): Promise<SessionView | undefined> {
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.cancelTask();
      await this.waitForInteraction();
    }
    await this.persistTuiSession();
    const stored = await this.sessionStore.ensureConversation(id) ?? this.sessionStore.find(id);
    if (!stored) return undefined;
    await this.restoreStoredSession(stored, !this.explicitModel);
    await this.persistTuiSession(false);
    this.followUps.splice(0);
    this.pendingPlanExecute = undefined;
    this.previousPlanPermissionMode = undefined;
    this.refreshTui();
    return this.toSessionView(this.currentSession ?? stored);
  }

  private async deleteSession(id: string): Promise<SessionView | undefined> {
    if (this.sessionSelection || this.interactionRunning() || this.hasPendingApprovals()) return undefined;
    await this.persistTuiSession();
    const activeId = this.currentSession?.id;
    const removed = await this.sessionStore.remove(id);
    if (!removed) return undefined;
    this.contextManagers.delete(id);
    this.followUps.splice(0);
    this.pendingPlanExecute = undefined;
    this.previousPlanPermissionMode = undefined;
    if (id === activeId) {
      const replacement = await this.sessionStore.ensureCurrent("Current session", {
        workMode: this.workMode,
        permissionMode: this.permissionMode,
        reasoningEffort: this.reasoningEffort,
        ...(this.model ? { modelReference: this.modelReference(this.model) } : {}),
        conversation: [],
      });
      await this.restoreStoredSession(replacement, !this.explicitModel);
      this.refreshTui();
      return this.toSessionView(replacement);
    }
    const active = activeId ? this.sessionStore.find(activeId) : undefined;
    if (!active) return undefined;
    this.currentSession = active;
    return this.toSessionView(active);
  }

  private async createSession(name?: string): Promise<SessionView | undefined> {
    if (this.sessionSelection || this.interactionRunning() || this.hasPendingApprovals()) return undefined;
    await this.persistTuiSession();
    const stored = await this.sessionStore.create(name, {
      workMode: this.workMode,
      permissionMode: this.permissionMode,
      reasoningEffort: this.reasoningEffort,
      ...(this.model ? { modelReference: this.modelReference(this.model) } : {}),
      conversation: [],
    });
    this.currentSession = stored;
    this.sessionGeneration += 1;
    this.conversation = [];
    // 新建并挂载会话时清空 once 集合，同时清空通知队列残留。
    this.hookEngine?.resetOnce();
    this.hookEngine?.drainNotices();
    await this.refreshSessionKnowledge();
    this.contextManagers.delete(stored.id);
    await this.currentContextManager();
    this.modelWarning = undefined;
    this.permissionMode = stored.permissionMode ?? (stored.workMode === "plan" ? "plan" : this.permissionMode);
    this.workMode = workModeForPermission(this.permissionMode);
    this.reasoningEffort = stored.reasoningEffort ?? "medium";
    this.followUps.splice(0);
    this.pendingPlanExecute = undefined;
    this.previousPlanPermissionMode = undefined;
    this.refreshTui();
    return this.toSessionView(stored);
  }

  private async renameSession(id: string, name: string): Promise<SessionView | undefined> {
    if (this.interactionRunning() || this.hasPendingApprovals()) return undefined;
    await this.persistTuiSession();
    const stored = await this.sessionStore.update(id, { name, autoNamed: false, titleSource: "manual" });
    if (!stored) return undefined;
    if (this.currentSession?.id === stored.id) {
      this.currentSession = stored;
      this.refreshTui();
    }
    return this.toSessionView(stored);
  }

  private async loadWorkspaceFiles(query: string): Promise<string[]> {
    return this.workspaceFileIndex.search(query, 200);
  }

  private async onEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === "assistant_end") this.latestUsage = { ...event.usage };
    this.debugRuntimeStream(event);
    if (event.type === "context_compaction") {
      this.writeDebugLog(JSON.stringify({
        event: "context_compaction",
        phase: event.phase,
        reason: event.reason,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        replacementCount: event.replacementCount,
        message: event.message,
      }));
    }
    if (event.type === "plan_complete") {
      const sessionId = this.currentSession?.id ?? "session-current";
      this.pendingPlanExecute = {
        sessionId,
        plan: event.plan,
        prompt: buildPlanExecutePrompt(event.plan),
      };
      if (this.permissionMode === "plan") {
        this.permissionMode = this.permissionModeAfterPlan();
        this.workMode = workModeForPermission(this.permissionMode);
        event.permissionMode = this.permissionMode;
        event.workMode = this.workMode;
        this.refreshTui();
        await this.persistTuiSession();
      }
    }
    if (event.type === "task_plan_updated") {
      if (this.currentSession) {
        this.currentSession.planState = structuredClone(event.planState);
      }
    }
    this.renderer.render(event);
    await this.tui?.flushPendingRender(renderCommitKind(event));
    this.scheduleTuiSessionPersist();
  }

  private scheduleTuiSessionPersist(): void {
    if (this.sessionPersistTimer) return;
    this.sessionPersistTimer = setTimeout(() => {
      this.sessionPersistTimer = undefined;
      void this.persistTuiSession();
    }, 250);
  }

  private debugRuntimeStream(event: RuntimeEvent): void {
    const taskSequenceKey = event.taskId;
    const lastSequence = this.debugStreamSequences.get(taskSequenceKey);
    const sequenceGap = lastSequence !== undefined && event.sequence !== lastSequence + 1;
    this.debugStreamSequences.set(taskSequenceKey, event.sequence);
    const turnKey = `${event.taskId}:${event.turnId ?? "current"}`;
    if (event.type === "assistant_delta" || event.type === "assistant_end") {
      if (event.type === "assistant_delta") {
        const turn = this.debugStreamTurns.get(turnKey) ?? { deltaEvents: 0, deltaChars: 0 };
        turn.deltaEvents += 1;
        turn.deltaChars += event.text.length;
        this.debugStreamTurns.set(turnKey, turn);
      }
      const turn = this.debugStreamTurns.get(turnKey) ?? { deltaEvents: 0, deltaChars: 0 };
      this.writeDebugLog(JSON.stringify({
        event: "runtime_stream",
        type: event.type,
        taskId: event.taskId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        sequence: event.sequence,
        lastSequence,
        sequenceGap,
        deltaEvents: turn.deltaEvents,
        deltaChars: turn.deltaChars,
        ...(event.type === "assistant_end" ? {
          finalChars: event.text.length,
          finalCodePoints: [...event.text].length,
        } : {}),
      }));
      if (event.type === "assistant_end") this.debugStreamTurns.delete(turnKey);
    }
    if (event.type === "completed"
      || event.type === "cancelled"
      || (event.type === "state" && (event.state === "failed" || event.state === "cancelled"))) {
      this.debugStreamSequences.delete(event.taskId);
      for (const key of [...this.debugStreamTurns.keys()]) {
        if (key.startsWith(`${event.taskId}:`)) this.debugStreamTurns.delete(key);
      }
    }
  }

  private async flushBackgroundNotifications(): Promise<void> {
    if (this.taskRunning()) return;
    const runtime = this.agentRuntime;
    if (!runtime) return;
    const { backgroundTaskNotification } = await loadSubagentBackground();
    const notifications = runtime.backgroundAgents.drainNotifications().map(backgroundTaskNotification);
    if (!notifications.length) return;
    for (const notification of notifications) {
      this.conversation.push({
        role: "system",
        content: notification,
        metadata: { promptBlock: "task-notification", contextManaged: true },
      });
      this.renderer.markdown("Background task", notification);
    }
    await this.persistTuiSession();
    this.refreshTui();
  }

  private loadFollowUpOptions(): import("./tui/types.js").FollowUpOption[] {
    const sessionId = this.currentSession?.id ?? "session-current";
    return this.followUps
      .filter((item) => item.sessionId === sessionId)
      .map((item) => ({ id: item.id, prompt: item.prompt, createdAt: item.createdAt }));
  }

  private cancelFollowUp(id: string): boolean {
    const sessionId = this.currentSession?.id ?? "session-current";
    const index = this.followUps.findIndex((item) => item.id === id && item.sessionId === sessionId);
    if (index < 0) return false;
    this.followUps.splice(index, 1);
    this.refreshTui();
    return true;
  }

  private hasPendingApprovals(): boolean {
    return this.pendingApprovals.length > 0;
  }

  private requestApproval(
    call: ToolCall,
    level: number,
    description: string,
    origin: SubagentOrigin,
    requestId: string,
  ): Promise<ApprovalResponse> {
    // Non-interactive sessions (e.g. `oran run --once`) have no readline or
    // TUI to present an approval prompt. Auto-deny rather than hanging forever.
    if (!this.isReadlineActive() && !this.tui) {
      this.renderer.error(
        `approval required for ${call.name} but no interactive session is available; use --approve-all to run non-interactively`,
      );
      return Promise.resolve(false);
    }
    return new Promise<ApprovalResponse>((resolveApproval) => {
      this.pendingApprovals.push({
        call,
        level,
        description,
        requestId,
        origin,
        resolve: resolveApproval,
        presented: false,
        settled: false,
      });
      this.presentNextApproval();
    });
  }

  private presentNextApproval(): void {
    const pending = this.pendingApprovals[0];
    if (!pending || pending.presented || pending.settled) return;
    pending.presented = true;
    const rendered = this.renderer.approval(
      pending.call,
      pending.level,
      pending.description,
      pending.origin,
    );
    if (rendered && typeof rendered.then === "function") {
      void rendered.then((response) => this.settleApproval(pending, response));
    }
  }

  private settleApproval(pending: PendingApproval, response: ApprovalResponse): void {
    if (pending.settled) return;
    const index = this.pendingApprovals.indexOf(pending);
    if (index < 0) return;
    pending.settled = true;
    const wasHead = index === 0;
    this.pendingApprovals.splice(index, 1);
    pending.resolve(response);
    if (wasHead) this.presentNextApproval();
  }

  private cancelApprovalsForOrigin(origin: SubagentOrigin): void {
    const head = this.pendingApprovals[0];
    const cancelled = this.pendingApprovals.filter((pending) => sameApprovalOrigin(pending.origin, origin));
    if (!cancelled.length) return;
    const cancelledHead = head !== undefined && cancelled.includes(head);
    for (const pending of cancelled) {
      pending.settled = true;
      const index = this.pendingApprovals.indexOf(pending);
      if (index >= 0) this.pendingApprovals.splice(index, 1);
      pending.resolve(false);
    }
    if (cancelledHead) this.renderer.cancelApproval?.();
    this.presentNextApproval();
  }

  private resolveApproval(value: string): void {
    const pending = this.pendingApprovals[0];
    if (!pending) return;
    const answer = value.toLowerCase();
    if (answer === "y" || answer === "yes") {
      this.settleApproval(pending, true);
    } else if (answer === "a" || answer === "always") {
      this.settleApproval(pending, "always");
    } else if (answer === "n" || answer === "no" || answer === "esc" || answer === "") {
      this.settleApproval(pending, false);
    } else {
      this.renderer.status("Please answer y, a, or n.", "yellow");
    }
  }

  private async handleCommand(value: string): Promise<void> {
    await this.initializeCommandIntegrations();
    const parsed = parseSlashCommand(value);
    if (!parsed) return;
    const command = this.commandRegistry.get(parsed.name);
    if (!command) {
      this.renderer.error(`Unknown command: ${parsed.name}. Use /help.`);
      return;
    }
    this.commandUsage?.record(command.name);
    const { name } = command;
    const { argument } = parsed;

    if (command.description.endsWith("[skill]")) {
      await this.handleSkillCommand(name, argument);
      return;
    }

    if (command.kind === "prompt") {
      const prompt = command.handler ? await command.handler(argument) : argument;
      if (!prompt.trim()) this.renderer.error(`Command ${name} did not produce a prompt.`);
      else await this.submitUserPrompt(prompt);
      return;
    }
    if (command.kind === "isolated-skill") {
      if (this.interactionRunning() || this.hasPendingApprovals()) {
        this.renderer.status("finish or cancel the current interaction before running an isolated skill", "yellow");
        return;
      }
      const prompt = command.handler ? await command.handler(argument) : argument;
      if (!prompt.trim()) {
        this.renderer.error(`Command ${name} did not produce a skill prompt.`);
        return;
      }
      this.renderer.user(`[isolated skill] ${name}${argument ? ` ${argument}` : ""}`);
      this.setPrompt();
      this.launchTask(prompt, true, false, true);
      return;
    }
    if (command.kind === "local") {
      const output = await this.handleLocalCommand(command, argument);
      this.renderer.markdown(name, output);
      return;
    }

    switch (command.action) {
      case "skills": {
        const output = await this.handleLocalCommand(command, argument);
        this.renderer.markdown(name, output);
        return;
      }
      case "new": {
        const session = await this.createSession(argument || undefined);
        if (session) this.renderer.status(`Started session ${session.name}.`, "cyan");
        return;
      }
      case "model":
        await this.handleModel(argument);
        return;
      case "connect":
        await this.handleConnect(argument);
        return;
      case "session":
        await this.handleSessionCommand(argument);
        return;
      case "permission":
        await this.handlePermissionCommand(argument);
        return;
      case "plan":
        if (argument) this.renderer.error("/plan does not accept arguments");
        else await this.changePermissionMode("plan");
        return;
      case "compact":
        if (argument) {
          this.renderer.error("/compact does not accept arguments");
          return;
        }
        await this.runManualCompaction();
        return;
      case "clear":
        if (this.interactionRunning() || this.hasPendingApprovals()) {
          this.renderer.status("finish or cancel the current task before clearing the transcript", "yellow");
          return;
        }
        this.renderer.clearTranscript();
        this.conversation = [];
        (await this.currentContextManager()).reset();
        await this.persistTuiSession();
        this.renderer.status("Transcript cleared.", "cyan");
        return;
      case "rename": {
        const nameValue = argument.trim();
        if (!nameValue) {
          this.renderer.error("usage: /rename NAME");
          return;
        }
        const session = this.currentSession ? await this.renameSession(this.currentSession.id, nameValue) : undefined;
        if (session) this.renderer.status(`Session renamed to ${session.name}.`, "cyan");
        else this.renderer.error("cannot rename the active session while a task is running");
        return;
      }
      case "undo": {
        if (argument) {
          this.renderer.error(`${name} does not accept arguments`);
          return;
        }
        if (this.interactionRunning() || this.hasPendingApprovals()) {
          this.renderer.status("finish or cancel the current task before undoing files", "yellow");
          return;
        }
        const sessionId = this.currentSession?.id;
        if (!sessionId) {
          this.renderer.error("No active session is available for undo.");
          return;
        }
        const runtime = await this.ensureAgentRuntime();
        const result = await runtime.snapshotStore.undoLatest(sessionId);
        if (result.ok) this.renderer.status(result.output, "cyan");
        else this.renderer.error(result.output);
        return;
      }
      case "exit":
        this.quitRequested = true;
        if (this.tui) this.tui.destroy();
        else if (this.readline) this.closeReadline();
        return;
      default:
        this.renderer.error(`Command ${name} has no UI action configured.`);
    }
  }

  private async handleLocalCommand(command: SlashCommand, argument: string): Promise<string> {
    switch (command.name) {
      case "/help": {
        const target = argument ? this.commandRegistry.get(argument) : undefined;
        if (argument && !target) return `Unknown command: ${argument}. Use /help.`;
        if (!target) return commandHelp(this.commandRegistry.list());
        const aliases = target.aliases?.length ? target.aliases.join(", ") : "(none)";
        const usage = target.usage ?? `${target.name}${target.argumentHint ? ` ${target.argumentHint}` : ""}`;
        return `${usage}\n${target.description}\nAliases: ${aliases}\nType: ${target.kind}`;
      }
      case "/status": {
        await this.ensureMcpReady();
        const usage = this.tui?.snapshot().session.usage;
        const inputTokens = usage?.inputTokens ?? tokenValue(this.latestUsage, "input_tokens", "inputTokens");
        const outputTokens = usage?.outputTokens ?? tokenValue(this.latestUsage, "output_tokens", "outputTokens");
        const { ToolRegistry, registerBuiltinTools } = await loadTools();
        const registry = new ToolRegistry();
        registerBuiltinTools(registry, this.workspace);
        this.registerMcpTools(registry);
        const servers = this.mcpManager?.connectedServers() ?? [];
        return [
          `permission: ${this.permissionMode}`,
          `tokens.input: ${inputTokens}`,
          `tokens.output: ${outputTokens}`,
          `tools: ${(await this.toolSchemasForCurrentMode(registry)).length}`,
          `mcp: ${servers.length} servers, ${this.mcpManager?.toolCount ?? 0} tools`,
          `memory.entries: ${countPromptEntries(this.stablePromptModules.longTermMemory)}`,
          `model: ${this.modelLabel()}`,
          `workspace: ${this.workspace}`,
        ].join("\n");
      }
      case "/memory": {
        if (argument.trim().toLowerCase() === "clear") {
          const { longTermMemory: _discarded, ...remainingModules } = this.stablePromptModules;
          this.stablePromptModules = remainingModules;
          return "Loaded long-term memory cleared for subsequent tasks.";
        }
        if (argument) return "Usage: /memory [clear]";
        return this.stablePromptModules.longTermMemory?.trim() || "No long-term memory is loaded.";
      }
      case "/skills": {
        if (argument) return "Usage: /skills";
        const skills = this.skillLoader.list();
        return skills.length
          ? ["Available Skills:", ...skills.map((skill) => `/${skill.name} — ${skill.description}`)].join("\n")
          : "No Skills were found in the built-in, user, or project Skill directories.";
      }
      case "/worktree": {
        try {
          const result = await execAsync("git worktree list --porcelain", { cwd: this.workspace, windowsHide: true });
          return result.stdout.trim() || "No Git worktrees were reported.";
        } catch {
          return "Git worktree information is unavailable for this workspace.";
        }
      }
      case "/mcp": {
        await this.ensureMcpReady();
        const servers = this.mcpManager?.connectedServers() ?? [];
        const failures = this.mcpManager?.failures() ?? [];
        if (!servers.length) {
          return failures.length
            ? ["No MCP servers are connected.", ...failures.map((item) => `- ${item.name}: ${item.error}`)].join("\n")
            : "No MCP servers are connected.";
        }
        return [
          ...servers.map((server) => `- ${server.name}: ${server.toolCount} tools`),
          `Total: ${servers.length} servers, ${this.mcpManager?.toolCount ?? 0} tools`,
          ...(failures.length ? ["Failed:", ...failures.map((item) => `- ${item.name}: ${item.error}`)] : []),
        ].join("\n");
      }
      default:
        return command.handler ? await command.handler(argument) : `Command ${command.name} has no local handler configured.`;
    }
  }

  private async handleSkillCommand(commandName: string, argument: string): Promise<void> {
    const name = commandName.replace(/^\//, "");
    const skill = await this.skillLoader.get(name);
    if (!skill) {
      this.renderer.error(`Skill not found: ${name}`);
      return;
    }

    await this.ensureMcpReady();
    const { ToolRegistry, registerBuiltinTools } = await loadTools();
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, this.workspace);
    this.registerMcpTools(registry);
    this.registerSkillSystemTools(registry);
    try {
      assertSkillTools(skill, registry.list().map((tool) => tool.name));
    } catch (error) {
      this.renderer.error(formatErrorMessage(error));
      return;
    }

    const prompt = renderSkillPrompt(skill, argument);
    if (skill.mode === "derived") {
      if (this.interactionRunning() || this.hasPendingApprovals()) {
        this.renderer.status("finish or cancel the current interaction before running a derived skill", "yellow");
        return;
      }
      this.renderer.user(`[derived skill] /${skill.name}${argument ? ` ${argument}` : ""}`);
      this.setPrompt();
      this.launchTask(prompt, true, false, true, skill);
      return;
    }

    this.activeSkills.set(skill.name, { definition: skill, prompt });
    const request = argument
      ? `Execute the activated Skill /${skill.name} for this request: ${argument}`
      : `Execute the activated Skill /${skill.name}.`;
    await this.submitUserPrompt(request);
  }

  private registerSkillSystemTools(registry: ToolRegistry): void {
    registry.register({
      name: "activate_skill",
      description: "Load and activate a Skill SOP by name for the current runtime.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name, with or without a leading slash." } },
        required: ["name"],
      },
      permissionLevel: 0,
      system: true,
      kind: "readonly",
      maxOutputChars: 40_000,
      invoke: async (call) => {
        const requested = typeof call.arguments.name === "string" ? call.arguments.name.replace(/^\//, "").trim() : "";
        const skill = requested ? await this.skillLoader.get(requested) : undefined;
        if (!skill) {
          const available = this.skillLoader.list();
          return {
            ok: false,
            output: available.length
              ? available.map((item) => `/${item.name} — ${item.description}`).join("\n")
              : "No Skills are available.",
            error: requested ? `Skill not found: ${requested}` : "Skill name is required.",
            summary: "skill not found",
          };
        }
        try {
          assertSkillTools(skill, registry.list().map((tool) => tool.name));
          const prompt = renderSkillPrompt(skill);
          this.activeSkills.set(skill.name, { definition: skill, prompt });
          return { ok: true, output: prompt, summary: `activated Skill ${skill.name}` };
        } catch (error) {
          return { ok: false, output: "", error: formatErrorMessage(error), summary: "skill activation failed" };
        }
      },
    });

    registry.register({
      name: "install_skill",
      description: "Install a Skill definition from a local path or HTTP/HTTPS URL into the current project.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Local file/directory path or HTTP/HTTPS URL." },
          name: { type: "string", description: "Optional Skill name override." },
        },
        required: ["source"],
      },
      permissionLevel: 3,
      system: true,
      kind: "write",
      maxOutputChars: 8_000,
      invoke: async (call) => {
        const source = typeof call.arguments.source === "string" ? call.arguments.source.trim() : "";
        const name = typeof call.arguments.name === "string" ? call.arguments.name.trim() : undefined;
        if (!source) return { ok: false, output: "", error: "Skill source is required.", summary: "skill installation failed" };
        try {
          const installed = await this.skillLoader.install(source, name);
          await this.loadCommandRegistry();
          this.refreshTui();
          return {
            ok: true,
            output: `Installed Skill /${installed.name} at ${installed.filePath}`,
            summary: `installed Skill ${installed.name}`,
          };
        } catch (error) {
          return { ok: false, output: "", error: formatErrorMessage(error), summary: "skill installation failed" };
        }
      },
    });
  }

  private registerMcpTools(registry: ToolRegistry): void {
    if (!this.mcpManager) return;
    for (const definition of this.mcpManager.toolDefinitions()) {
      if (!registry.has(definition.name)) registry.register(definition);
    }
    if (this.mcpManager.toolCount === 0) return;
    const search = this.mcpManager.searchToolDefinition();
    if (!registry.has(search.name)) registry.register(search);
  }

  private async toolSchemasForCurrentMode(registry: ToolRegistry): Promise<Record<string, unknown>[]> {
    const { isPlanModeTool } = await loadTools();
    return registry.schemas((tool) => {
      if (this.workMode === "plan" && !isPlanModeTool(tool)) return false;
      return !this.mcpManager?.isMcpTool(tool.name) || this.mcpManager.isActivated(tool.name);
    });
  }

  private startMcpConnections(): void {
    if (this.mcpManager || this.mcpReady) return;
    this.mcpReady = (async () => {
      const { McpManager } = await loadMcpManager();
      if (this.mcpManager) return;
      this.mcpManager = new McpManager(this.config.mcpServers ?? {}, this.workspace);
      await this.mcpManager.connect();
      this.injectMcpSystemMessages();
      this.refreshTui();
    })();
  }

  private async ensureMcpReady(): Promise<void> {
    this.startMcpConnections();
    await this.mcpReady;
    this.injectMcpSystemMessages();
  }

  private injectMcpSystemMessages(): void {
    const manager = this.mcpManager;
    if (!manager) return;
    let changed = false;
    for (const instruction of manager.instructions()) {
      const exists = this.conversation.some((message) => (
        message.metadata?.promptBlock === "mcp-instructions"
        && message.metadata.mcpServer === instruction.server
      ));
      if (exists) continue;
      this.conversation.push({
        role: "system",
        content: `MCP server ${instruction.server} instructions:\n${instruction.text}`,
        metadata: { promptBlock: "mcp-instructions", mcpServer: instruction.server, contextManaged: true },
      });
      changed = true;
    }
    const reminder = manager.discoveryReminder();
    const discoveryIndex = this.conversation.findIndex((message) => message.metadata?.promptBlock === "mcp-discovery");
    if (reminder && discoveryIndex < 0) {
      this.conversation.push({
        role: "system",
        content: reminder,
        metadata: { promptBlock: "mcp-discovery", contextManaged: true },
      });
      changed = true;
    } else if (reminder && this.conversation[discoveryIndex]?.content !== reminder) {
      this.conversation[discoveryIndex] = {
        role: "system",
        content: reminder,
        metadata: { promptBlock: "mcp-discovery", contextManaged: true },
      };
      changed = true;
    } else if (!reminder && discoveryIndex >= 0) {
      this.conversation.splice(discoveryIndex, 1);
      changed = true;
    }
    const failures = manager.failures();
    const hasFailureMessage = this.conversation.some((message) => message.metadata?.promptBlock === "mcp-failure");
    if (failures.length && !hasFailureMessage) {
      const content = ["Some MCP servers failed to connect:", ...failures.map((item) => `- ${item.name}: ${item.error}`)].join("\n");
      this.conversation.push({
        role: "system",
        content,
        metadata: { promptBlock: "mcp-failure", contextManaged: true },
      });
      changed = true;
      if (!this.mcpFailuresShown) {
        this.mcpFailuresShown = true;
        this.renderer.error(content);
      }
    }
    if (changed) void this.persistTuiSession();
  }

  private activeSkillReminders(): readonly string[] {
    return [...this.activeSkills.values()].map(({ definition, prompt }) => (
      this.formatActiveSkillReminder(definition.name, prompt)
    ));
  }

  private formatActiveSkillReminder(name: string, prompt: string): string {
    return `<active-skill name="${name}">\n${prompt}\n</active-skill>`;
  }

  private isToolAllowedByActiveSkills(toolName: string): boolean {
    const constrained = [...this.activeSkills.values()]
      .map(({ definition }) => definition.allowedTools)
      .filter((allowedTools) => allowedTools.length > 0);
    return constrained.length === 0 || constrained.every((allowedTools) => allowedTools.includes(toolName));
  }

  private derivedSkillConversation(skill: SkillDefinition): Message[] {
    const limit = skill.context === "recent" ? 10 : skill.context === "long" ? 50 : 0;
    return limit === 0 ? [] : structuredClone(this.conversation.slice(-limit));
  }

  private async handlePermissionCommand(argument: string): Promise<void> {
    const value = argument.trim().toLowerCase();
    if (!value) {
      this.renderer.status(`Permission mode: ${this.permissionMode}. Valid modes: ${PERMISSION_MODES.join(", ")}.`, "cyan");
      return;
    }
    if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
      this.renderer.error(`invalid permission mode: ${value}; use ${PERMISSION_MODES.join(", ")}`);
      return;
    }
    await this.changePermissionMode(value as PermissionMode);
  }

  private async changePermissionMode(mode: PermissionMode): Promise<boolean> {
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.renderer.status("finish or cancel the current task before changing permission mode", "yellow");
      return false;
    }
    if (mode === "plan" && this.permissionMode !== "plan") {
      this.previousPlanPermissionMode = this.permissionMode;
      this.pendingPlanExecute = undefined;
    } else if (mode !== "plan" && this.permissionMode === "plan") {
      this.previousPlanPermissionMode = undefined;
    }
    if (mode !== this.permissionMode) this.pendingPlanExecute = undefined;
    this.permissionMode = mode;
    this.workMode = workModeForPermission(mode);
    this.refreshTui();
    await this.persistTuiSession();
    this.renderer.status(`Permission mode set to ${mode}.`, "cyan");
    return true;
  }

  private permissionModeAfterPlan(): PermissionMode {
    const previous = this.previousPlanPermissionMode;
    this.previousPlanPermissionMode = undefined;
    if (previous && previous !== "plan") return previous;
    const configured = configuredPermissionMode(this.config, this.approveAll);
    return configured === "plan" ? "default" : configured;
  }

  private async handleConnect(_argument = ""): Promise<void> {
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.renderer.status("finish or cancel the current task before connecting a provider", "yellow");
      return;
    }
    if (this.tui) await this.tui.openConnect();
  }

  private async applyConnectProvider(input: ConnectInput): Promise<boolean | void> {
    try {
      const configPath = userConfigReadPath();
      const config = await loadConfigFile(configPath);
      const providerName = input.providerName;
      const options: Record<string, unknown> = {
        baseURL: input.baseURL,
        protocol: input.protocol,
      };
      if (input.apiKey) options.apiKey = input.apiKey;
      const models: Record<string, ModelProfile> = {};
      for (const model of input.models) {
        const modelOptions: Record<string, unknown> = { reasoningEffort: input.reasoningEffort };
        if (model.contextWindow !== undefined) modelOptions.contextWindow = model.contextWindow;
        models[model.id] = { options: modelOptions };
      }
      const profile: ProviderProfile = { options: options as ProviderOptions, models };
      config.providers = { ...config.providers, [providerName]: profile };
      const firstSelectedModel = input.models.find((m) => m.selected) ?? input.models[0];
      await saveConfig(config, configPath);
      this.config = await loadConfig(this.workspace);
      if (firstSelectedModel) {
        await this.handleModel(`${providerName}/${firstSelectedModel.id}`);
      }
      return true;
    } catch (error) {
      this.renderer.error(formatErrorMessage(error));
      return false;
    }
  }

  private async handleModel(argument: string): Promise<boolean> {
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.renderer.status("finish or cancel the current task before changing the model", "yellow");
      return false;
    }
    if (!argument && this.tui) {
      await this.tui.openModels();
      return true;
    }
    try {
      const fresh = await loadConfig(this.workspace);
      const models = modelCandidates(fresh.providers);
      if (!argument) {
        this.renderer.status(`Available models: ${models.length ? models.join(", ") : "(none configured)"}`, "cyan");
        this.renderer.status(`Current model: ${this.modelLabel()}.`, "cyan");
        return true;
      }
      const next = resolveModelConfig(fresh, argument);
      this.model = next;
      this.reasoningEffort = next.reasoningEffort ?? "medium";
      (await this.currentContextManager()).resetUsageAnchor();
      this.modelWarning = undefined;
      this.renderer.status(`Model set to ${formatModelReference(this.model)}.`, "cyan");
      this.refreshTui();
      await this.persistTuiSession();
      await this.rememberModelPreference(next);
      return true;
    } catch (error) {
      this.renderer.error(formatErrorMessage(error));
      return false;
    }
  }

  private async handleSessionCommand(argument = ""): Promise<void> {
    const id = argument.trim();

    if (id) {
      const restored = await this.selectSession(id);
      if (restored) {
        this.tui?.restoreSessionView(restored, `Restored session ${restored.id}: ${restored.name}.`);
        if (!this.tui) this.renderer.status(`Restored session ${restored.id}: ${restored.name}.`, "cyan");
      }
      else this.renderer.error(`Session not found: ${id}`);
      return;
    }
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.renderer.status("finish or cancel the current task before switching sessions", "yellow");
      return;
    }
    if (this.tui) await this.tui.openSessions();
    else {
      const sessions = this.sessionStore.list();
      const output = sessions.length
        ? `${sessions.map((session) => `${session.id} (${session.archiveMessageCount ?? session.conversation?.length ?? 0} messages) — ${this.sessionName(session)}`).join("\n")}\n\nUse /session ID to resume.`
        : "No sessions in this workspace.";
      this.renderer.status(output, "cyan");
    }
  }

  private async runManualCompaction(): Promise<void> {
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.renderer.status("finish or cancel the current interaction before compacting context", "yellow");
      return;
    }
    if (!this.model) {
      this.renderer.error("no model selected; use /model PROVIDER/MODEL first");
      return;
    }
    if (!this.conversation.length) {
      this.renderer.status("No conversation context to compact.", "yellow");
      return;
    }

    await this.ensureMcpReady();
    const sessionId = this.currentSession?.id;
    const sessionGeneration = this.sessionGeneration;
    const manager = await this.currentContextManager();
    const { ToolRegistry, registerBuiltinTools } = await loadTools();
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, this.workspace);
    this.registerMcpTools(registry);
    const tools = await this.toolSchemasForCurrentMode(registry);
    const requestModel: ModelConfig = { ...this.model, reasoningEffort: this.reasoningEffort };
    const contextWindow = manager.resolveContextWindow(requestModel);
    const beforeTokens = manager.estimateTokens(this.conversation, tools);
    const abortController = new AbortController();
    this.compactAbortController = abortController;

    const compactPromise = Promise.resolve().then(async (): Promise<void> => {
      await this.emitContextCompaction({
        phase: "started",
        reason: "manual",
        beforeTokens,
        replacementCount: 0,
      });
      try {
        const compacted = await manager.compact({
          messages: this.conversation,
          provider: this.providerFactory(requestModel),
          tools,
          contextWindow,
          reason: "manual",
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) throw new DOMException("operation aborted", "AbortError");
        if (this.sessionGeneration !== sessionGeneration || this.currentSession?.id !== sessionId) {
          throw new Error("active session changed while context compaction was running");
        }
        this.conversation = compacted.messages;
        await this.persistTuiSession();
        await this.emitContextCompaction({
          phase: "completed",
          reason: "manual",
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          replacementCount: compacted.replacementCount,
        });
      } catch (error) {
        const cancelled = abortController.signal.aborted || isAbortError(error);
        await this.emitContextCompaction({
          phase: "failed",
          reason: "manual",
          beforeTokens,
          replacementCount: 0,
          message: cancelled ? "Context compaction cancelled." : formatErrorMessage(error),
        });
      }
    });

    this.compactPromise = compactPromise;
    this.setPrompt();
    this.refreshTui();
    try {
      await compactPromise;
    } finally {
      if (this.compactPromise === compactPromise) this.compactPromise = undefined;
      if (this.compactAbortController === abortController) this.compactAbortController = undefined;
      this.setPrompt();
      this.refreshTui();
      this.prompt();
    }
  }

  private async emitContextCompaction(payload: RuntimeEventPayloads["context_compaction"]): Promise<void> {
    await this.onEvent({
      version: 1,
      type: "context_compaction",
      taskId: `context-${this.currentSession?.id ?? "current"}`,
      sequence: ++this.contextEventSequence,
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }

  private async runTui(history: readonly string[]): Promise<void> {
    const isRunning = (): boolean => this.interactionRunning() || this.hasPendingApprovals();
    const { InkTuiApp } = await loadInkApp();
    const tui = new InkTuiApp({
      input: this.input,
      output: this.output,
      getWorkspace: () => this.workspace,
      getCommands: () => this.commandSnapshot(),
      getModelLabel: () => this.modelLabel(),
      onRenderDebug: (info) => this.writeDebugLog(JSON.stringify({ event: "tui_render", ...info })),
      onInput: (value) => this.handleInput(value),
      onCancel: () => {
        const hadPendingPlan = this.pendingPlanExecute !== undefined;
        const hadWork = isRunning() || hadPendingPlan;
        if (hadPendingPlan) {
          this.pendingPlanExecute = undefined;
          this.renderer.status("Plan discarded.", "cyan");
          this.refreshTui();
          void this.persistTuiSession();
          return true;
        }
        this.cancelTask();
        return hadWork;
      },
      loadModels: async () => {
        const fresh = await loadConfig(this.workspace);
        return modelCandidates(fresh.providers);
      },
      onModelSelected: (reference) => this.handleModel(reference),
      loadRemoteModels: async (baseURL, apiKey, protocol) => {
        const { fetchRemoteModels } = await import("./provider.js");
        const remote = await fetchRemoteModels(baseURL, apiKey, protocol);
        return remote.map((model): ConnectModelOption => {
          const next: ConnectModelOption = { id: model.id, selected: false };
          if (model.contextWindow !== undefined) next.contextWindow = model.contextWindow;
          return next;
        });
      },
      onConnect: async (input) => this.applyConnectProvider(input),
      loadSessions: () => this.loadSessionOptions(),
      onSessionSelected: (id) => this.selectSession(id),
      onSessionCreated: (name) => this.createSession(name),
      onSessionDeleted: (id) => this.deleteSession(id),
      loadFollowUps: () => this.loadFollowUpOptions(),
      onFollowUpCancelled: (id) => this.cancelFollowUp(id),
      loadFiles: (query) => this.loadWorkspaceFiles(query),
      onSessionChanged: () => this.persistTuiSession(),
      getFollowUpCount: () => this.followUps.length,
      getSessionName: () => this.currentSession ? this.sessionName(this.currentSession) : "Current session",
      getApprovalPolicy: () => this.permissionMode === "bypass" ? "all" : "ask",
      getWorkMode: () => this.workMode,
      getPermissionMode: () => this.permissionMode,
      onWorkModeChanged: async (mode) => {
        if (this.interactionRunning() || this.hasPendingApprovals()) return false;
        if (mode === "plan") {
          if (this.permissionMode !== "plan") {
            this.previousPlanPermissionMode = this.permissionMode;
            this.pendingPlanExecute = undefined;
          }
          this.permissionMode = "plan";
          this.workMode = "plan";
        } else {
          if (mode !== this.workMode) this.pendingPlanExecute = undefined;
          this.permissionMode = this.permissionMode === "plan"
            ? this.permissionModeAfterPlan()
            : this.permissionMode;
          this.workMode = mode;
        }
        await this.persistTuiSession();
        return true;
      },
      onPermissionModeChanged: async (mode) => {
        if (this.interactionRunning() || this.hasPendingApprovals()) return false;
        if (mode === "plan" && this.permissionMode !== "plan") {
          this.previousPlanPermissionMode = this.permissionMode;
          this.pendingPlanExecute = undefined;
        } else if (mode !== "plan") {
          this.previousPlanPermissionMode = undefined;
        }
        if (mode !== this.permissionMode) this.pendingPlanExecute = undefined;
        this.permissionMode = mode;
        this.workMode = workModeForPermission(mode);
        await this.persistTuiSession();
        return true;
      },
      getReasoningEffort: () => this.reasoningEffort,
      onReasoningEffortChanged: (effort) => {
        if (this.interactionRunning() || this.hasPendingApprovals()) return false;
        this.reasoningEffort = effort;
        return true;
      },
      getContextWindow: () => this.model?.contextWindow,
      getModelReference: () => this.model
        ? this.modelReference(this.model)
        : this.currentSession?.modelReference,
      getModelWarning: () => this.modelWarning,
      isInteractionBlocked: () => this.interactionRunning() || this.hasPendingApprovals() || this.pendingPlanExecute !== undefined,
      history: this.currentSession?.history ?? history,
      ...(this.currentSession ? { initialSession: this.toSessionView(this.currentSession) } : {}),
    });
    this.tui = tui;
    this.renderer = tui.renderer;
    this.startMcpConnections();
    try {
      await tui.run();
    } finally {
      await this.persistTuiSession();
      await saveHistoryEntries(tui.history());
      tui.destroy();
      if (this.tui === tui) this.tui = undefined;
      await this.sessionSave;
    }
  }

  private async runShell(command: string): Promise<void> {
    if (!command) return;
    if (this.workMode === "plan") {
      this.renderer.error("plan mode is read-only; shell commands are disabled");
      return;
    }
    if (this.interactionRunning() || this.hasPendingApprovals()) {
      this.renderer.error("finish or cancel the current task before running a shell command");
      return;
    }
    const abortController = new AbortController();
    this.shellAbortController = abortController;
    const shellPromise = (async () => {
      try {
        const result = await execAsync(command, { cwd: this.workspace, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal: abortController.signal });
        if (abortController.signal.aborted) {
          this.renderer.markdown(`$ ${command} (cancelled)`, "shell command cancelled");
        } else {
          const output = `${result.stdout}${result.stderr}`.trim();
          this.renderer.markdown(`$ ${command} (exit 0)`, output || "(no output)");
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          this.renderer.markdown(`$ ${command} (cancelled)`, "shell command cancelled");
        } else {
          const item = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
          const output = `${item.stdout ?? ""}${item.stderr ?? ""}`.trim();
          this.renderer.error(`shell command failed (exit ${String(item.code ?? "unknown")})${output ? `\n${output}` : ""}`);
        }
      }
      await this.persistTuiSession();
    })();
    this.shellPromise = shellPromise;
    try {
      await shellPromise;
    } finally {
      if (this.shellPromise === shellPromise) this.shellPromise = undefined;
      if (this.shellAbortController === abortController) this.shellAbortController = undefined;
      this.setPrompt();
    }
  }

  cancel(): void {
    if (this.pendingPlanExecute) {
      this.pendingPlanExecute = undefined;
      this.renderer.status("Plan discarded.", "cyan");
      this.refreshTui();
      void this.persistTuiSession();
      return;
    }
    const hadWork = this.interactionRunning() || this.hasPendingApprovals();
    this.cancelTask();
    if (hadWork) return;
    // Prefer the TUI exit owner so Ctrl+C confirmation stays single-shot.
    if (this.tui) {
      this.tui.handleExternalInterrupt();
      return;
    }
    if (this.readline) {
      this.quitRequested = true;
      this.closeReadline();
    }
  }

  private cancelTask(): void {
    if (this.taskRunning() || this.pendingApprovals.some((pending) => pending.origin.kind === "main")) {
      this.queuePaused = true;
    }
    this.cancelApprovalsForOrigin({ kind: "main" });
    for (const abortController of this.hookSubagentAbortControllers) abortController.abort();
    this.controller?.cancel();
    this.shellAbortController?.abort();
    this.compactAbortController?.abort();
  }

  private taskRunning(): boolean {
    return this.taskPromise !== undefined;
  }

  private shellRunning(): boolean {
    return this.shellPromise !== undefined;
  }

  private compactRunning(): boolean {
    return this.compactPromise !== undefined;
  }

  private interactionRunning(): boolean {
    return this.taskRunning() || this.shellRunning() || this.compactRunning();
  }

  private async waitForTask(): Promise<void> {
    const task = this.taskPromise;
    if (task) await task.catch(() => undefined);
  }

  private async waitForCompaction(): Promise<void> {
    const compact = this.compactPromise;
    if (compact) await compact.catch(() => undefined);
  }

  private async waitForInteraction(): Promise<void> {
    await Promise.all([
      this.waitForTask(),
      this.shellPromise?.catch(() => undefined) ?? Promise.resolve(),
      this.waitForCompaction(),
    ]);
  }

  private scheduleMemoryExtraction(sessionId: string, messages: readonly Message[], model: ModelConfig): void {
    const snapshot = serializeMemorySnapshot(messages);
    const previous = this.memorySnapshots.get(sessionId);
    if (!snapshot || memorySnapshotDelta(previous, snapshot) < 40) return;
    this.pendingMemorySnapshots.set(snapshot, sessionId);
    const modelKey = `${model.provider}/${model.model}/${model.baseUrl ?? ""}`;
    const job = (async () => {
      const extractor = await this.ensureMemoryExtractor(model, modelKey);
      await extractor.extract(snapshot).catch(() => undefined);
    })();
    this.memoryExtractionJobs.add(job);
    void job.then(
      () => this.memoryExtractionJobs.delete(job),
      () => this.memoryExtractionJobs.delete(job),
    );
  }

  private ensureMemoryExtractor(model: ModelConfig, modelKey: string): Promise<MemoryExtractor> {
    const current = this.memoryExtractor;
    if (current && (current.isRunning() || this.memoryExtractorModelKey === modelKey)) return Promise.resolve(current);
    if (this.memoryExtractorInit) return this.memoryExtractorInit;

    const initialization = (async () => {
      const existing = this.memoryExtractor;
      if (existing && (existing.isRunning() || this.memoryExtractorModelKey === modelKey)) return existing;
      const { MemoryExtractor } = await loadMemoryExtractor();
      const extractor = new MemoryExtractor({
        manager: this.memoryManager,
        provider: this.providerFactory(model),
        onProcessed: (processedSnapshot, notes, succeeded) => {
          const processedSessionId = this.pendingMemorySnapshots.get(processedSnapshot);
          this.pendingMemorySnapshots.delete(processedSnapshot);
          if (!processedSessionId) return;
          if (succeeded) this.memorySnapshots.set(processedSessionId, processedSnapshot);
          if (notes.length && this.currentSession?.id === processedSessionId) {
            this.renderer.status(`Saved memory: ${notes.map((note) => note.id).join(", ")}.`, "cyan");
          }
        },
      });
      this.memoryExtractor = extractor;
      this.memoryExtractorModelKey = modelKey;
      return extractor;
    })();
    this.memoryExtractorInit = initialization;
    void initialization.then(
      () => { if (this.memoryExtractorInit === initialization) this.memoryExtractorInit = undefined; },
      () => { if (this.memoryExtractorInit === initialization) this.memoryExtractorInit = undefined; },
    );
    return initialization;
  }

  private complete(
    line: string,
    callback: (error: Error | null, result?: CompleterResult) => void,
  ): void {
    void loadConfig(this.workspace)
      .then((config) => callback(null, completeInput(line, modelCandidates(config.providers), this.commandSnapshot())))
      .catch((error: unknown) => {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          completeInput(line, this.model ? [formatModelReference(this.model)] : [], this.commandSnapshot()),
        );
      });
  }

  private modelLabel(): string {
    return this.model ? formatModelReference(this.model) : "(not selected)";
  }

  private sessionTitleMode(): SessionTitleMode {
    return this.config.sessionTitles?.mode ?? "local";
  }

  private sessionName(session: StoredSession): string {
    return displaySessionName(session, this.sessionTitleMode());
  }

  private scheduleModelSessionTitle(sessionId: string, model: ModelConfig): void {
    if (this.sessionTitleMode() !== "model") return;
    const abortController = new AbortController();
    this.titleAbortControllers.add(abortController);
    const job = this.generateModelSessionTitle(sessionId, model, abortController.signal)
      .catch(() => undefined)
      .finally(() => {
        this.titleJobs.delete(job);
        this.titleAbortControllers.delete(abortController);
      });
    this.titleJobs.add(job);
  }

  private async generateModelSessionTitle(sessionId: string, model: ModelConfig, signal: AbortSignal): Promise<void> {
    const stored = await this.sessionStore.ensureConversation(sessionId) ?? this.sessionStore.find(sessionId);
    const prompt = firstConversationPrompt(stored?.conversation ?? []);
    if (!prompt || !await this.markTitleGenerationAttempted(sessionId)) return;

    const configuredModel = this.config.sessionTitles?.model
      ? resolveModelConfig(await loadConfig(this.workspace), this.config.sessionTitles.model)
      : model;
    const titleModel: ModelConfig = {
      ...configuredModel,
      temperature: Math.min(configuredModel.temperature, 0.2),
      maxTokens: Math.min(configuredModel.maxTokens, 64),
    };
    const response = await this.providerFactory(titleModel).complete([
      {
        role: "system",
        content: "Create a concise session title for a coding-agent conversation. Return only the title: 12-24 Chinese characters or at most 8 English words. Do not use quotes, markdown, trailing punctuation, or generic labels.",
      },
      { role: "user", content: prompt.slice(0, 2_000) },
    ], [], { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    const title = normalizeGeneratedSessionTitle(response.text);
    if (!title) return;
    await this.persistGeneratedSessionTitle(sessionId, title);
  }

  private async markTitleGenerationAttempted(sessionId: string): Promise<boolean> {
    let marked = false;
    this.sessionSave = this.sessionSave.then(async () => {
      const session = this.sessionStore.find(sessionId);
      if (!session || session.titleGenerationAttempted || !isAutomaticSessionName(session) || session.titleSource === "model") return;
      const updated = await this.sessionStore.update(sessionId, { titleGenerationAttempted: true });
      if (!updated) return;
      marked = true;
      if (this.currentSession?.id === sessionId) this.currentSession = updated;
    }).catch(() => undefined);
    await this.sessionSave;
    return marked;
  }

  private async persistGeneratedSessionTitle(sessionId: string, title: string): Promise<void> {
    this.sessionSave = this.sessionSave.then(async () => {
      const session = this.sessionStore.find(sessionId);
      if (!session || !isAutomaticSessionName(session) || session.titleSource === "manual") return;
      const updated = await this.sessionStore.update(sessionId, {
        name: title,
        autoNamed: true,
        titleSource: "model",
        titleGenerationAttempted: true,
      });
      if (updated && this.currentSession?.id === sessionId) {
        this.currentSession = updated;
        this.refreshTui();
      }
    }).catch(() => undefined);
    await this.sessionSave;
  }

  private setPrompt(): void {
    if (!this.isReadlineActive()) return;
    this.readline?.setPrompt(this.interactionRunning() ? `${CLI_NAME}* > ` : `${CLI_NAME} > `);
  }

  private prompt(): void {
    if (!this.isReadlineActive()) return;
    this.readline?.prompt();
  }

  private isReadlineActive(): boolean {
    return this.readline !== undefined && !this.readlineClosed && !this.inputEnded && !this.quitRequested;
  }

  private closeReadline(): void {
    const readline = this.readline;
    if (!readline || this.readlineClosed) return;
    this.readlineClosed = true;
    readline.close();
  }

  private async openTrace(): Promise<void> {
    if (this.trace) return;
    this.traceOpen ??= (async () => {
      const { SqliteTraceStore } = await loadTrace();
      if (this.trace) return;
      await migrateUserDataOutOfWorkspace(this.workspace);
      const traceRoot = userTraceRoot(this.workspace);
      await mkdir(traceRoot, { recursive: true });
      this.trace = await SqliteTraceStore.open(resolve(traceRoot, "trace.db"), this.workspace);
    })().catch((error) => {
      // Allow a later attempt to retry a transient open failure.
      this.traceOpen = undefined;
      throw error;
    });
    await this.traceOpen;
  }

  private async ensureAgentStateRestored(): Promise<void> {
    this.agentStateRestore ??= (async () => {
      const runtime = await this.ensureAgentRuntime();
      await Promise.all([
        runtime.backgroundAgents.restore(),
        runtime.teams.restore(),
      ]);
    })();
    await this.agentStateRestore;
  }

  private writeDebugLog(message: string): void {
    const enabled = /^(1|true|yes)$/i.test(process.env.ORAN_DEBUG ?? "");
    if (!enabled) return;
    const path = resolve(projectStateRoot(this.workspace), "debug", "agent.jsonl");
    this.debugLogTail = this.debugLogTail
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), data: message })}\n`, "utf8");
      })
      .catch(() => undefined);
  }

  private async closeTrace(): Promise<void> {
    // `run()` opens tracing in the background. Wait for that initialization to
    // settle before closing so a late SQLite open cannot leak past shutdown.
    await this.traceOpen?.catch(() => undefined);
    this.trace?.close();
    this.trace = undefined;
    this.traceOpen = undefined;
  }

  private async shutdown(): Promise<void> {
    this.quitRequested = true;
    this.cancelTask();
    for (const controller of this.titleAbortControllers) controller.abort();
    await this.waitForTask();
    await this.waitForCompaction();
    const runtime = this.agentRuntime;
    // Ensure background agent state restore finished before tearing services down,
    // so teams.restore() can never race teams.shutdown() on a quick exit.
    await this.agentStateRestore?.catch(() => undefined);
    runtime?.backgroundAgents.interruptAll();
    for (const abortController of this.hookSubagentAbortControllers) abortController.abort();
    if (runtime) {
      await runtime.teams.shutdown();
      await runtime.backgroundAgents.waitForIdle();
      await runtime.backgroundAgents.flush();
      await runtime.teams.flush();
      await runtime.agentStateStore.flush();
    }
    await Promise.allSettled([...this.hookSubagentJobs]);
    await this.persistTuiSession();
    await Promise.allSettled([...this.titleJobs]);
    await this.memoryExtractorInit?.catch(() => undefined);
    while (this.memoryExtractionJobs.size > 0) {
      await Promise.allSettled([...this.memoryExtractionJobs]);
    }
    await this.memoryExtractor?.waitForIdle();
    await this.mcpManager?.close();
    const tui = this.tui;
    tui?.destroy();
    if (this.tui === tui) this.tui = undefined;
    await this.sessionSave;
    if (this.readline) {
      await saveHistory(this.readline);
      this.closeReadline();
      this.renderer.attachPrompt(undefined);
      this.readline = undefined;
    }
    await this.closeTrace();
    await this.commandUsage?.flush();
  }
}

function renderCommitKind(event: RuntimeEvent): TuiRenderCommitKind {
  switch (event.type) {
    case "assistant_start":
    case "thought_start":
    case "tool_start":
    case "retry":
      return "boundary";
    case "assistant_end":
    case "assistant_abort":
    case "error":
    case "cancelled":
      return "terminal";
    case "completed":
      return "boundary";
    case "context_compaction":
      return event.phase === "started" ? "boundary" : "normal";
    case "state":
      if (event.state === "failed" || event.state === "cancelled" || event.state === "paused") return "terminal";
      return event.state === "planning"
        || event.state === "executing"
        || event.state === "verifying"
        || event.state === "awaiting_approval"
        ? "boundary"
        : "normal";
    default:
      return "normal";
  }
}

function sameApprovalOrigin(left: SubagentOrigin, right: SubagentOrigin): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "main" || right.kind === "main") return true;
  if (left.taskId && right.taskId) return left.taskId === right.taskId;
  if (left.kind === "teammate" && right.kind === "teammate") {
    return left.teamName === right.teamName && left.name === right.name;
  }
  return left.name === right.name;
}

function configuredPermissionMode(config: UserConfig, approveAll: boolean): PermissionMode {
  if (config.agent?.workMode === "plan") return "plan";
  return config.agent?.permissionMode ?? (approveAll ? "bypass" : "default");
}

function resolveRememberedModel(config: UserConfig): ModelConfig | undefined {
  const reference = config.agent?.lastModel;
  if (!reference) return undefined;
  try {
    return resolveModelConfig(config, reference);
  } catch {
    return undefined;
  }
}

function workModeForPermission(mode: PermissionMode): WorkMode {
  return mode === "plan" ? "plan" : "auto";
}

function isReusableBlankSession(session: StoredSession): boolean {
  if (!isAutomaticSessionName(session) || session.messages.length !== 0) return false;
  // Prefer the derived archive counter written while the body was known.
  if (session.archiveMessageCount !== undefined) return session.archiveMessageCount === 0;
  // Conversation already materialised.
  if (session.conversation !== undefined) return session.conversation.length === 0;
  // Metadata-only open without a known body size must not look blank.
  return false;
}

function createSessionGapReminder(updatedAt: string, now = new Date()): Message | undefined {
  const previous = Date.parse(updatedAt);
  if (!Number.isFinite(previous)) return undefined;
  const elapsedDays = Math.floor((now.getTime() - previous) / 86_400_000);
  if (elapsedDays < SESSION_GAP_REMINDER_DAYS) return undefined;
  return {
    role: "system",
    content: [
      "<system-reminder>",
      `This session was last active on ${new Date(previous).toISOString().slice(0, 10)}, about ${elapsedDays} days ago.`,
      "Re-check time-sensitive assumptions and the current workspace state before continuing unfinished work.",
      "Do not respond to this reminder as a user message.",
      "</system-reminder>",
    ].join("\n"),
    metadata: { promptBlock: "session-gap-reminder", contextManaged: true },
  };
}

function serializeMemorySnapshot(messages: readonly Message[]): string {
  const candidates = messages
    .filter((message) => message.role !== "system")
    .slice(-48)
    .map((message) => {
      const content = message.content?.trim().slice(0, 4_000) ?? "";
      const calls = message.toolCalls?.length
        ? `\nTool calls: ${message.toolCalls.map((call) => call.name).join(", ")}`
        : "";
      if (content.length < 8 && !calls) return "";
      return `${message.role.toUpperCase()}${message.name ? ` (${message.name})` : ""}:\n${content}${calls}`.trim();
    })
    .filter(Boolean);
  const retained: string[] = [];
  let bytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const candidateBytes = Buffer.byteLength(`${candidate}\n\n`, "utf8");
    if (bytes + candidateBytes > 32_000) break;
    retained.unshift(candidate);
    bytes += candidateBytes;
  }
  return retained.join("\n\n");
}

function memorySnapshotDelta(previous: string | undefined, current: string): number {
  if (!previous) return current.length;
  let common = 0;
  const maximum = Math.min(previous.length, current.length);
  while (common < maximum && previous.charCodeAt(common) === current.charCodeAt(common)) common += 1;
  return current.length - common;
}

function isApprovalAnswer(value: string): boolean {
  return ["y", "yes", "a", "always", "n", "no", "esc"].includes(value.toLowerCase());
}

function tokenValue(usage: Readonly<Record<string, number>>, ...keys: string[]): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function countPromptEntries(value: string | undefined): number {
  return value?.split(/\r?\n/).filter((line) => line.trim().length > 0).length ?? 0;
}

async function loadHistory(): Promise<string[]> {
  for (const path of [userHistoryPath(), legacyUserHistoryPath()]) {
    try {
      return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).reverse();
    } catch {
      // Try the legacy location before starting with an empty history.
    }
  }
  return [];
}

function restoreHistory(readline: Interface, history: readonly string[]): void {
  const target = readline as Interface & { history?: string[] };
  if (Array.isArray(target.history)) target.history.push(...history);
}

async function saveHistory(readline: Interface): Promise<void> {
  const history = (readline as Interface & { history?: string[] }).history;
  if (!history?.length) return;
  await saveHistoryEntries(history);
}

async function saveHistoryEntries(history: readonly string[]): Promise<void> {
  if (!history.length) return;
  const file = userHistoryPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${history.slice(0, 1000).reverse().join("\n")}\n`, "utf8");
}

export function supportsTui(input: NodeJS.ReadableStream, output: NodeJS.WriteStream): boolean {
  return Boolean((input as NodeJS.ReadStream).isTTY && output.isTTY);
}

function buildPlanExecutePrompt(plan: string): string {
  return [
    "Execute the approved implementation plan below.",
    "Follow the steps closely, make the smallest safe changes, and verify when appropriate.",
    "Do not restate the whole plan unless needed; start working.",
    "",
    "Plan:",
    plan.trim(),
  ].join("\n");
}

function normalizeGeneratedSessionTitle(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return undefined;
  const normalized = line
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^[#*`'"“”‘’\s]+|[#*`'"“”‘’\s]+$/g, "")
    .replace(/[。.!！?？:：;,，；]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? truncateSessionName(normalized, 48) : undefined;
}
