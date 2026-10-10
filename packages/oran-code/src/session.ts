import { createInterface, type CompleterResult, type Interface } from "node:readline";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import {
  legacyUserHistoryPath,
  loadConfig,
  loadConfigFile,
  resolveModelConfig,
  saveConfig,
  userConfigReadPath,
  userHistoryPath,
} from "./config.js";
import {
  CommandRegistry,
  completeInput,
  formatModelReference,
  modelCandidates,
  type SlashCommand,
} from "./commands.js";
import { createModelProvider, OpenAICompatibleProvider, resolveProviderProtocolFor } from "./provider.js";
import { createRuntimeConfig } from "./runtime.js";
import { ApprovalQueue, isApprovalAnswer } from "./approval-queue.js";
import { SessionTitleService } from "./session-title.js";
import { MemoryExtractionScheduler } from "./memory-extraction.js";
import { McpSessionIntegration } from "./mcp/session-integration.js";
import { SessionCommandRouter } from "./session-commands.js";
import { SessionCommandHandlers, type SessionCommandHandlersPort } from "./session-command-handlers.js";
import { StreamDebugTracker, createDebugLogSink, type DebugLogSink } from "./session-debug.js";
import {
  configuredPermissionMode,
  createSessionGapReminder,
  isReusableBlankSession,
  workModeForPermission,
} from "./session-lifecycle.js";
import { SessionCrudService } from "./session-crud.js";
import { workspaceFingerprint } from "./controller-utils.js";
import { ProgressStateStore } from "./progress/store.js";
import { TerminalRenderer, createPromptHooks, type SessionRenderer } from "./renderer.js";
import { createTask } from "./types.js";
import { SessionStore, type StoredSession } from "./session-store.js";
import { displaySessionName, isAutomaticSessionName } from "./session-naming.js";
import type {
  ApprovalResponse,
  Message,
  ModelConfig,
  ModelProvider,
  ModelReference,
  OptionalSystemPromptModules,
  PermissionMode,
  ReasoningEffort,
  RuntimeEvent,
  RuntimeEventPayloads,
  SessionTitleMode,
  Task,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UserConfig,
  WorkMode,
} from "./types.js";
import type { ConnectModelOption, TuiRenderCommitKind } from "./tui/types.js";
import { WorkspaceFileIndex } from "./tui/composer/file-completion.js";
import { formatErrorMessage } from "./error-format.js";
import { registerDynamicMarkdownCommands } from "./dynamic-commands.js";
import { CommandUsageTracker } from "./command-usage.js";
import {
  assertSkillTools,
  registerSkillCommands,
  renderSkillPrompt,
  SkillLoader,
  type SkillDefinition,
} from "./skills.js";
import { MemoryManager } from "./memory-manager.js";
import { sweepOrphanWorktrees } from "./worktree/lifecycle.js";
import type { HookEngine, HookSubAgentExecutor } from "./hook/index.js";
import {
  CLI_NAME,
  ensureProjectStateRoot,
  migrateUserDataOutOfWorkspace,
  PRODUCT_NAME,
  userTraceRoot,
} from "./paths.js";
import type { SubagentOrigin } from "./subagent/types.js";
import type { QuestionItem } from "./tools/interaction-tools.js";
import type { ContextManager } from "./context-manager.js";
import { userTurnIndices } from "./message-utils.js";
import type { TaskController } from "./controller.js";
import type { SqliteTraceStore } from "./trace.js";
import type { ToolRegistry } from "./tools.js";
import type { InkTuiApp } from "./tui/ink-app.js";
import type { BackgroundAgentTaskManager } from "./subagent/background.js";
import type { AgentDefinitionLoader } from "./subagent/roles.js";
import type { SubagentRunner } from "./subagent/runner.js";
import type { TeamManager } from "./subagent/team.js";
import type { SnapshotStore } from "./snapshot.js";
import type { AgentStateStore } from "./subagent/state-store.js";

const execAsync = promisify(exec);
const SESSION_EXPIRY_DAYS = 30;

/** Cached dynamic imports so cold-start stays light but first use pays once. */
const loadInkApp = () => import("./tui/ink-app.js");
const loadController = () => import("./controller.js");
const loadHookFacade = () => import("./hook/index.js");
const loadContextManager = () => import("./context-manager.js");
const loadTools = () => import("./tools.js");
const loadTrace = () => import("./trace.js");
const loadProjectInstructionsMod = () => import("./project-instructions.js");
const loadSubagentBackground = () => import("./subagent/background.js");
const loadShellJobs = () => import("./tools/jobs.js");
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
  permissionMode?: PermissionMode;
  providerFactory?: (model: ModelConfig) => ModelProvider;
  stablePromptModules?: OptionalSystemPromptModules;
  onCommandReloadReady?: (reload: () => Promise<void>) => void;
  /**
   * Receives every runtime event for this session. Used by the scripted
   * `--output` JSONL log; implementations must not throw.
   */
  runtimeEventSink?: (event: RuntimeEvent) => void;
}

interface FollowUpItem {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly workMode: WorkMode;
  readonly permissionMode: PermissionMode;
  readonly createdAt: string;
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
  private previousReadonlyResults: ReadonlyMap<string, ToolResult> | undefined;
  private previousWorkspaceFingerprint: string | undefined;
  private contextEventSequence = 0;
  private readonly approvalQueue: ApprovalQueue;
  private workMode: WorkMode;
  private permissionMode: PermissionMode;
  private reasoningEffort: ReasoningEffort;
  private readonly sessionStore: SessionStore;
  private readonly crud: SessionCrudService;
  private readonly handlers: SessionCommandHandlers;
  private readonly workspaceFileIndex: WorkspaceFileIndex;
  private currentSession: StoredSession | undefined;
  private readonly followUps: FollowUpItem[] = [];
  /** Plan completed in plan mode and is waiting for an explicit user decision. */
  private pendingPlanExecute: { sessionId: string; plan: string; prompt: string } | undefined;
  private previousPlanPermissionMode: PermissionMode | undefined;
  private queuePaused = false;
  private sessionSave: Promise<void> = Promise.resolve();
  private sessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly titles: SessionTitleService;
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
  private readonly memoryExtraction: MemoryExtractionScheduler;
  private commandRegistry = new CommandRegistry();
  private readonly skillLoader: SkillLoader;
  private readonly activeSkills = new Map<string, ActiveSkill>();
  private readonly configuredActiveSkills: string | undefined;
  private commandUsage: CommandUsageTracker | undefined;
  private commandIntegrationPromise: Promise<void> | undefined;
  private latestUsage: Record<string, number> = {};
  private readonly debugLogSink: DebugLogSink;
  private readonly debugTracker: StreamDebugTracker;
  private readonly runtimeEventSink: ((event: RuntimeEvent) => void) | undefined;
  private hookEngine: HookEngine | undefined;
  private hookWarningsShown = false;
  private readonly hookSubagentAbortControllers = new Set<AbortController>();
  private readonly hookSubagentJobs = new Set<Promise<void>>();
  private readonly mcp: McpSessionIntegration;
  private readonly commandRouter: SessionCommandRouter;
  private agentRuntime: AgentRuntimeServices | undefined;
  private agentRuntimePromise: Promise<AgentRuntimeServices> | undefined;
  private agentStateRestore: Promise<void> | undefined;

  constructor(
    options: SessionOptions,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
  ) {
    this.workspace = resolve(options.workspace);
    this.debugLogSink = createDebugLogSink(this.workspace);
    this.debugTracker = new StreamDebugTracker((message) => this.debugLogSink(message));
    this.explicitModel = options.model !== undefined;
    this.model = options.model ?? resolveRememberedModel(options.config);
    this.config = options.config;
    this.approveAll = options.approveAll;
    this.permissionMode = options.permissionMode ?? configuredPermissionMode(options.config, options.approveAll);
    this.workMode = workModeForPermission(this.permissionMode);
    this.reasoningEffort = this.model?.reasoningEffort ?? "medium";
    this.sessionStore = new SessionStore(this.workspace);
    this.crud = new SessionCrudService({
      persistTuiSession: (includeTuiSnapshot) => this.persistTuiSession(includeTuiSnapshot),
      sessionStore: this.sessionStore,
      currentSession: () => this.currentSession,
      setCurrentSession: (session) => {
        this.currentSession = session;
      },
      sessionName: (session) => this.sessionName(session),
      model: () => this.model,
      modelWarning: () => this.modelWarning,
      setModelWarning: (warning) => {
        this.modelWarning = warning;
      },
      explicitModel: () => this.explicitModel,
      modelReference: (model) => this.modelReference(model),
      interactionRunning: () => this.interactionRunning(),
      hasPendingApprovals: () => this.hasPendingApprovals(),
      cancelTask: () => this.cancelTask(),
      waitForInteraction: () => this.waitForInteraction(),
      restoreStoredSession: (stored, applyModel) => this.restoreStoredSession(stored, applyModel),
      refreshTui: () => this.refreshTui(),
      clearFollowUps: () => {
        this.followUps.splice(0);
      },
      clearPendingPlanExecute: () => {
        this.pendingPlanExecute = undefined;
      },
      previousPlanPermissionMode: () => this.previousPlanPermissionMode,
      setPreviousPlanPermissionMode: (mode) => {
        this.previousPlanPermissionMode = mode;
      },
      bumpSessionGeneration: () => {
        this.sessionGeneration += 1;
      },
      setConversation: (messages) => {
        this.conversation = messages;
      },
      resetHookOnce: () => {
        this.hookEngine?.resetOnce();
        this.hookEngine?.drainNotices();
      },
      refreshSessionKnowledge: () => this.refreshSessionKnowledge(),
      deleteContextManager: (sessionId) => {
        this.contextManagers.delete(sessionId);
      },
      ensureCurrentContextManager: () => this.currentContextManager(),
      permissionMode: () => this.permissionMode,
      setPermissionMode: (mode) => {
        this.permissionMode = mode;
      },
      workMode: () => this.workMode,
      setWorkMode: (mode) => {
        this.workMode = mode;
      },
      reasoningEffort: () => this.reasoningEffort,
      setReasoningEffort: (value) => {
        this.reasoningEffort = value;
      },
    });
    this.handlers = new SessionCommandHandlers(this.handlersPort());
    this.workspaceFileIndex = new WorkspaceFileIndex(this.workspace);
    this.skipVerify = options.config.agent?.skipVerify ?? (options.config.agent?.verifyCommands?.length ? false : true);
    this.runtimeEventSink = options.runtimeEventSink;
    this.input = input;
    this.output = output;
    this.renderer = new TerminalRenderer(output);
    this.approvalQueue = new ApprovalQueue({
      renderer: () => this.renderer,
      isInteractive: () => this.isReadlineActive() || Boolean(this.tui),
    });
    const baseProviderFactory = options.providerFactory ?? ((model: ModelConfig) => createModelProvider(model));
    this.providerFactory = (model: ModelConfig) => {
      const provider = baseProviderFactory(model);
      if (provider instanceof OpenAICompatibleProvider) {
        provider.onReasoningUnsupported = () => this.handleReasoningUnsupported(model);
        provider.onReasoningEchoRequired = () => this.handleReasoningEchoRequired(model);
      }
      return provider;
    };
    this.configuredStablePromptModules = { ...options.stablePromptModules };
    this.stablePromptModules = { ...this.configuredStablePromptModules };
    this.memoryManager = new MemoryManager(this.workspace);
    this.mcp = new McpSessionIntegration({
      workspace: this.workspace,
      config: () => this.config,
      conversation: () => this.conversation,
      persistSession: () => {
        void this.persistTuiSession();
      },
      onError: (message) => this.renderer.error(message),
      onConnected: () => this.refreshTui(),
    });
    this.memoryExtraction = new MemoryExtractionScheduler({
      memoryManager: this.memoryManager,
      providerFactory: (model) => this.providerFactory(model),
      currentSessionId: () => this.currentSession?.id,
      onNotesSaved: (sessionId, noteIds) => {
        if (this.currentSession?.id !== sessionId) return;
        this.renderer.status(`Saved memory: ${noteIds.join(", ")}.`, "cyan");
      },
    });
    this.titles = new SessionTitleService({
      workspace: this.workspace,
      sessionStore: this.sessionStore,
      providerFactory: (model) => this.providerFactory(model),
      config: () => this.config,
      titleMode: () => this.sessionTitleMode(),
      runSerialSessionWrite: (task) => this.runSerialSessionWrite(task),
      onSessionUpdated: (updated, { refreshTui }) => {
        if (this.currentSession?.id !== updated.id) return;
        this.currentSession = updated;
        if (refreshTui) this.refreshTui();
      },
    });
    this.commandRouter = new SessionCommandRouter({
      workspace: this.workspace,
      renderer: () => this.renderer,
      initializeCommandIntegrations: () => this.initializeCommandIntegrations(),
      commands: () => this.commandRegistry,
      recordCommandUsage: (name) => {
        this.commandUsage?.record(name);
      },
      handleSkillCommand: (name, argument) => this.handleSkillCommand(name, argument),
      submitUserPrompt: (prompt) => this.submitUserPrompt(prompt),
      interactionRunning: () => this.interactionRunning(),
      hasPendingApprovals: () => this.hasPendingApprovals(),
      runIsolatedSkill: async (prompt) => {
        this.setPrompt();
        await this.launchTask(prompt, true, false, true);
      },
      createSession: (name) => this.crud.createSession(name),
      handleModel: async (argument) => {
        await this.handlers.handleModel(argument);
      },
      handleConnect: (argument) => this.handlers.handleConnect(argument),
      handleSessionCommand: (argument) => this.handlers.handleSessionCommand(argument),
      handlePermissionCommand: (argument) => this.handlers.handlePermissionCommand(argument),
      changePermissionMode: async (mode) => {
        await this.handlers.changePermissionMode(mode);
      },
      runManualCompaction: () => this.handlers.runManualCompaction(),
      clearTranscript: async () => {
        this.renderer.clearTranscript();
        this.conversation = [];
        (await this.currentContextManager()).reset();
        await this.persistTuiSession();
      },
      renameSession: (id, name) => this.crud.renameSession(id, name),
      currentSessionId: () => this.currentSession?.id,
      undoLatestChanges: async () => {
        const sessionId = this.currentSession?.id;
        if (!sessionId) return { ok: false, output: "No active session is available for undo." };
        const runtime = await this.ensureAgentRuntime();
        return runtime.snapshotStore.undoLatest(sessionId);
      },
      rewindConversation: (argument) => this.rewindConversation(argument),
      resumeProgressTask: () => this.resumeProgressTask(),
      requestExit: () => {
        this.quitRequested = true;
        if (this.tui) this.tui.destroy();
        else if (this.readline) this.closeReadline();
      },
      mcpStatus: async () => {
        await this.ensureMcpReady();
        return {
          servers: this.mcp.connectedServers(),
          failures: this.mcp.failures(),
          toolCount: this.mcp.toolCount,
        };
      },
      toolCountForCurrentMode: async () => {
        const registry = await this.buildToolRegistry();
        return (await this.toolSchemasForCurrentMode(registry)).length;
      },
      usageSummary: () => {
        const usage = this.tui?.snapshot().session.usage;
        return {
          inputTokens: usage?.inputTokens ?? tokenValue(this.latestUsage, "input_tokens", "inputTokens"),
          outputTokens: usage?.outputTokens ?? tokenValue(this.latestUsage, "output_tokens", "outputTokens"),
        };
      },
      permissionMode: () => this.permissionMode,
      longTermMemory: () => this.stablePromptModules.longTermMemory,
      clearLongTermMemory: () => {
        const { longTermMemory: _discarded, ...remainingModules } = this.stablePromptModules;
        this.stablePromptModules = remainingModules;
      },
      skillList: () => this.skillLoader.list(),
      modelLabel: () => this.modelLabel(),
      backgroundTasks: async () => {
        const runtime = await this.ensureAgentRuntime();
        const { shellJobs, formatJobOutput } = await loadShellJobs();
        const jobs = shellJobs()
          .list()
          .map((job) => ({
            id: job.id,
            name: job.command,
            kind: "job" as const,
            status: tuiJobStatus(job.status),
            startedAt: job.startedAt,
            ...(job.stdout || job.stderr ? { output: formatJobOutput(job) } : {}),
            ...(job.endedAt ? { endedAt: job.endedAt } : {}),
            ...(job.error ? { error: job.error } : {}),
          }));
        const subagents = runtime.backgroundAgents.list().map((task) => ({
          id: task.id,
          name: task.name,
          status: task.status,
          startedAt: task.startedAt,
          endedAt: task.endedAt,
          definitionName: task.definitionName,
          error: task.error,
          output: task.output,
        }));
        return [...subagents, ...jobs];
      },
    });
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
        backgroundAgents: new BackgroundAgentTaskManager(
          agentStateStore,
          () => this.flushBackgroundNotifications(),
          () => this.refreshTui(),
        ),
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
    const isTty = supportsTui(this.input, this.output);
    // In TUI mode, warm up the ink/react module graph ahead of time (pure-CPU module compilation),
    // overlapping with the IO of state-directory migration and history restore to shorten time to first frame.
    const inkReady = isTty ? loadInkApp() : undefined;
    if (inkReady) void inkReady.catch(() => undefined);
    await ensureProjectStateRoot(this.workspace);
    // First paint only needs history + a blank session. Heavy integrations load in the background.
    const [history] = await Promise.all([loadHistory(), this.openSessionStore()]);
    void this.ensureAgentStateRestored().catch((error) =>
      this.writeDebugLog(`agent state restore failed: ${String(error)}`),
    );
    void this.initializeCommandIntegrations()
      .then(() => this.refreshTui())
      .catch((error) => this.writeDebugLog(`command integrations failed: ${String(error)}`));
    void this.openTrace().catch((error) => this.writeDebugLog(`trace open failed: ${String(error)}`));
    if (isTty) {
      try {
        await this.runTui(history, inkReady);
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
      else if (input.startsWith("!"))
        this.renderer.error("finish or cancel the current task before running a shell command");
      else this.enqueueFollowUp(input);
      return;
    }

    if (input.startsWith("!")) {
      await this.runShell(input.slice(1).trim());
    } else if (this.taskRunning()) {
      if (this.controller?.hasActiveLoop()) {
        this.controller.pushSteeringMessage(input);
        this.renderer.user(`[Steering] ${input}`, false);
        this.renderer.status("Injected steering guidance into running task", "cyan");
        this.refreshTui();
        return;
      }
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

  /** Builds the Hook engine on first need and binds a Subagent Runner for the current task. */
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
      const job = run.then(
        () => undefined,
        () => undefined,
      );
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
        log: (message) => {
          try {
            this.renderer.status(message);
          } catch {
            /* ignore */
          }
        },
        sessionMessages: () => this.conversation,
        subAgentExecutor,
      });
      this.hookEngine = built.engine;
      // Validation errors are aggregated and presented in a single pass through a session system prompt
      if (!this.hookWarningsShown && built.errors.length) {
        this.hookWarningsShown = true;
        const lines = built.errors.map((e) => `Hook 配置警告：#${e.index}${e.id ? ` (${e.id})` : ""} ${e.message}`);
        this.renderer.error(lines.join("\n"));
        // Validation errors are presented to the model as an in-session system prompt message, with
        // the same fixed warning prefix the user-facing lines above carry.
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
    resumedGoalFingerprint?: string,
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
    await Promise.all([this.ensureMcpReady(), this.openTrace(), this.initializeCommandIntegrations()]);
    const [
      agentRuntime,
      { assembleSubagentStack, joinStructuredForkSummaries, disposeStructuredScope },
      { backgroundTaskNotification },
      { shellJobNotification, shellJobs },
      { TaskController },
      { ContextManager },
      { createHookEngine },
    ] = await Promise.all([
      this.ensureAgentRuntime(),
      loadSubagentAssembly(),
      loadSubagentBackground(),
      loadShellJobs(),
      loadController(),
      loadContextManager(),
      loadHookFacade(),
    ]);
    const registry = await this.buildToolRegistry({ skillTools: true });
    if (derivedSkill)
      assertSkillTools(
        derivedSkill,
        registry.list().map((tool) => tool.name),
      );
    const selectedModel = derivedSkill?.model ? resolveModelConfig(this.config, derivedSkill.model) : this.model;
    const requestModel: ModelConfig = { ...selectedModel, reasoningEffort: this.reasoningEffort };
    const runtimeConfig = createRuntimeConfig(
      this.workspace,
      requestModel,
      this.config,
      this.approveAll,
      this.workMode,
      this.permissionMode,
    );
    runtimeConfig.skipVerify = this.skipVerify;
    const trace = this.trace;
    if (!trace) throw new Error("trace store is not initialized");
    const sessionId = this.currentSession?.id;
    const sessionGeneration = this.sessionGeneration;
    const taskGeneration = this.taskGeneration;
    const derivedConversation = derivedSkill ? this.derivedSkillConversation(derivedSkill) : [];
    const parentToolFilter = (tool: ToolDefinition): boolean => {
      if (this.mcp.isMcpTool(tool.name) && !this.mcp.isActivated(tool.name)) return false;
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
        approvalCallback: (call, level, description, requestId, origin) =>
          this.requestApproval(call, level, description, origin, requestId),
        approvalCancellationCallback: (origin) => this.cancelApprovalsForOrigin(origin),
        parentToolFilter,
        isMcpTool: (name) => this.mcp.isMcpTool(name),
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
      parentConversation: () => (isolated ? derivedConversation : this.conversation),
      resolveModel: (reference) => resolveModelConfig(this.config, reference),
    });
    const hookEngine = await this.ensureHookEngine(runner);
    const consumedBackgroundNotifications: string[] = [];
    // Before reusing the readonly cache across prompts, confirm the workspace was not changed
    // externally between the two prompts.
    if (this.previousReadonlyResults !== undefined && this.previousWorkspaceFingerprint !== undefined && !isolated) {
      const current = await workspaceFingerprint(this.workspace).catch(() => undefined);
      if (current === undefined || current !== this.previousWorkspaceFingerprint) {
        this.previousReadonlyResults = undefined;
      }
    }
    const controller = new TaskController({
      config: runtimeConfig,
      provider: this.providerFactory(requestModel),
      registry,
      trace,
      conversation: isolated ? derivedConversation : this.conversation,
      contextManager: isolated
        ? new ContextManager({ workspace: this.workspace, conversation: derivedConversation })
        : await this.currentContextManager(),
      approvalCallback: (call, level, description, requestId) =>
        this.requestApproval(call, level, description, { kind: "main" }, requestId),
      askUserCallback: (questions) => this.requestUserQuestions(questions),
      eventCallback: (event) => this.onEvent(event),
      ...(!isolated
        ? {
            conversationCallback: (messages: readonly Message[]) => {
              if (
                this.sessionGeneration !== sessionGeneration ||
                this.taskGeneration !== taskGeneration ||
                this.currentSession?.id !== sessionId
              )
                return;
              // What controller's syncConversation passes in is already a private cloneMessages copy,
              // so a shallow array copy here isolates later push/splice, avoiding a full deep clone each turn.
              this.conversation = [...messages];
              this.scheduleTuiSessionPersist();
            },
          }
        : {}),
      stablePromptModules: this.stablePromptModules,
      runtimeReminders: () => {
        const reminders = derivedSkill
          ? [this.formatActiveSkillReminder(derivedSkill.name, renderSkillPrompt(derivedSkill))]
          : this.activeSkillReminders();
        const notifications = agentRuntime.backgroundAgents.drainNotifications().map(backgroundTaskNotification);
        consumedBackgroundNotifications.push(...notifications);
        const jobNotifications = shellJobs().drainNotifications().map(shellJobNotification);
        consumedBackgroundNotifications.push(...jobNotifications);
        return [...reminders, ...notifications, ...jobNotifications];
      },
      toolFilter: parentToolFilter,
      ...(hookEngine ? { hookEngine } : {}),
      hookUserPrompt: prompt,
      previousToolCalls: this.previousToolHistory,
      ...(this.previousReadonlyResults !== undefined ? { previousReadonlyResults: this.previousReadonlyResults } : {}),
      debugLogger: (message) => this.writeDebugLog(message),
      ...(resumedGoalFingerprint !== undefined ? { resumedGoalFingerprint } : {}),
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
      if (task.state === "completed") {
        this.renderer.status("Task completed.", "green");
        const contextMgr = this.currentSession ? this.contextManagers.get(this.currentSession.id) : undefined;
        const estimatedTokens = contextMgr ? contextMgr.estimateTokens(this.conversation) : 0;
        if (estimatedTokens >= 35_000) {
          this.renderer.status(
            `💡 Current context has accumulated ~${Math.round(estimatedTokens / 1000)}k tokens. If switching to a new topic, consider using /clear or /compact for better focus and lower latency.`,
            "cyan",
          );
        }
      } else if (task.state !== "cancelled") this.renderer.status(`Task ${task.state}.`, "yellow");
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
      consumedBackgroundNotifications.push(...shellJobs().drainNotifications().map(shellJobNotification));
      for (const notification of consumedBackgroundNotifications) {
        conversationSnapshot.push({
          role: "system",
          content: notification,
          metadata: { promptBlock: "task-notification", contextManaged: true },
        });
      }
      this.previousToolHistory = controller.toolCallHistory;
      this.previousReadonlyResults = controller.readonlyResultSnapshot;
      if (!isolated) {
        const fingerprint = await workspaceFingerprint(this.workspace).catch(() => undefined);
        if (fingerprint !== undefined) this.previousWorkspaceFingerprint = fingerprint;
      }
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

  private launchTask(
    prompt: string,
    printErrors: boolean,
    queued = false,
    isolated = false,
    derivedSkill?: SkillDefinition,
    progress?: { resumeGoal: string },
  ): void {
    if (queued) this.renderer.user(prompt, true);
    this.taskPromise = this.startTask(prompt, printErrors, isolated, derivedSkill, false, progress?.resumeGoal)
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
    if (
      this.queuePaused ||
      this.taskRunning() ||
      this.hasPendingApprovals() ||
      this.pendingPlanExecute ||
      this.quitRequested
    )
      return;
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
    return [...recent, ...commands.filter((command) => !recentNames.has(command.name))];
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
    const discoveredInstructions = [`Current date: ${new Date().toISOString().slice(0, 10)}`, projectInstructions]
      .filter((section) => section.trim())
      .join("\n\n");
    const customInstructions = [discoveredInstructions, this.configuredStablePromptModules.customInstructions]
      .filter((section): section is string => Boolean(section?.trim()))
      .join("\n\n---\n\n");
    const longTermMemory = [memorySummary, this.configuredStablePromptModules.longTermMemory]
      .filter((section): section is string => Boolean(section?.trim()))
      .join("\n\n---\n\n");
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
    // CRUD, title generation, and command handlers retain this same store.
    // Open it in place so those services see the loaded sessions as well.
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
      ? ((await this.sessionStore.update(reusable.id, {
          name: "Current session",
          autoNamed: true,
          titleSource: "local",
          titleGenerationAttempted: false,
          ...defaults,
          ...(!this.model ? { modelReference: null } : {}),
        })) ?? (await this.sessionStore.create("Current session", defaults)))
      : await this.sessionStore.create("Current session", defaults);
    await this.restoreStoredSession(stored, !this.explicitModel);
  }

  private async restoreStoredSession(stored: StoredSession, restoreModel: boolean): Promise<void> {
    this.sessionGeneration += 1;
    // Remounting a session clears the once set and discards notifications left over from the previous task.
    this.hookEngine?.resetOnce();
    this.hookEngine?.drainNotices();
    this.currentSession = structuredClone(stored);
    this.previousPlanPermissionMode = undefined;
    this.permissionMode =
      stored.permissionMode ??
      (stored.workMode === "plan" ? "plan" : configuredPermissionMode(this.config, this.approveAll));
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
    this.conversation = structuredClone(stored.conversation ?? []).filter(
      (message) => message.metadata?.promptBlock !== "session-gap-reminder",
    );
    const gapReminder = createSessionGapReminder(stored.updatedAt);
    if (gapReminder) this.conversation.unshift(gapReminder);
    const manager = await this.currentContextManager();
    await this.compactRestoredConversation(manager);
    if (this.currentSession) this.currentSession.conversation = structuredClone(this.conversation);
    if (this.model) await this.rememberModelPreference(this.model);
  }

  private async compactRestoredConversation(manager: ContextManager): Promise<void> {
    if (!this.model || !this.conversation.length) return;
    const registry = await this.buildToolRegistry({ mcp: "if-started" });
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

  /**
   * Persistence after the endpoint returns 400 for reasoning_effort: write it to the user config and
   * mark it in memory so later requests no longer carry the parameter. Best-effort; a failure does
   * not affect the parameter-stripping retry that was already completed.
   */
  private async handleReasoningUnsupported(model: ModelConfig): Promise<void> {
    const reference = formatModelReference(model);
    try {
      const path = userConfigReadPath();
      const userConfig = await loadConfigFile(path);
      const modelProfile = userConfig.providers[model.provider]?.models[model.model];
      if (modelProfile && modelProfile.options.disableReasoningEffort !== true) {
        modelProfile.options = { ...modelProfile.options, disableReasoningEffort: true };
        await saveConfig(userConfig, path);
        this.renderer.status(`reasoning_effort rejected by ${reference}; disabled and saved to config.`, "yellow");
      }
    } catch {
      return;
    }
    if (this.model?.provider === model.provider && this.model?.model === model.model) {
      this.model = { ...this.model, reasoningEffortDisabled: true };
    }
  }

  /**
   * Handling for when the endpoint requires reasoning_content to be echoed back: remembered only in
   * the current process, never written to the user config.
   * This is a context requirement of one conversation (the previous turn's reasoning must be sent
   * back verbatim), not an endpoint capability defect, and persisting it would pollute every future
   * session.
   */
  private handleReasoningEchoRequired(model: ModelConfig): void {
    if (this.model?.provider === model.provider && this.model?.model === model.model) {
      this.model = { ...this.model, reasoningEchoRequired: true };
    }
    this.renderer.status(
      `reasoning content must be echoed back to ${formatModelReference(model)}; enabled for this session.`,
      "yellow",
    );
  }

  /** Port for the slash command handlers: state reads/writes plus side-effect callbacks. */
  private handlersPort(): SessionCommandHandlersPort {
    return {
      workspace: this.workspace,
      renderer: () => this.renderer,
      tui: () => this.tui,
      config: () => this.config,
      setConfig: (config) => {
        this.config = config;
      },
      approveAll: () => this.approveAll,
      model: () => this.model,
      setModel: (model) => {
        this.model = model;
      },
      reasoningEffort: () => this.reasoningEffort,
      setReasoningEffort: (value) => {
        this.reasoningEffort = value;
      },
      permissionMode: () => this.permissionMode,
      setPermissionMode: (mode) => {
        this.permissionMode = mode;
      },
      workMode: () => this.workMode,
      setWorkMode: (mode) => {
        this.workMode = mode;
      },
      previousPlanPermissionMode: () => this.previousPlanPermissionMode,
      setPreviousPlanPermissionMode: (mode) => {
        this.previousPlanPermissionMode = mode;
      },
      clearPendingPlanExecute: () => {
        this.pendingPlanExecute = undefined;
      },
      conversation: () => this.conversation,
      setConversation: (messages) => {
        this.conversation = messages;
      },
      currentSessionId: () => this.currentSession?.id,
      sessionGeneration: () => this.sessionGeneration,
      interactionRunning: () => this.interactionRunning(),
      hasPendingApprovals: () => this.hasPendingApprovals(),
      refreshTui: () => this.refreshTui(),
      persistTuiSession: (includeTuiSnapshot) => this.persistTuiSession(includeTuiSnapshot),
      currentContextManager: () => this.currentContextManager(),
      rememberModelPreference: (model) => this.rememberModelPreference(model),
      modelLabel: () => this.modelLabel(),
      modelWarning: () => this.modelWarning,
      setModelWarning: (warning) => {
        this.modelWarning = warning;
      },
      selectSession: (id) => this.crud.selectSession(id),
      sessionStore: this.sessionStore,
      sessionName: (session) => this.sessionName(session),
      ensureMcpReady: () => this.ensureMcpReady(),
      registerMcpTools: (registry) => this.registerMcpTools(registry),
      toolSchemasForCurrentMode: (registry) => this.toolSchemasForCurrentMode(registry),
      providerFactory: (model) => this.providerFactory(model),
      emitContextCompaction: (payload) => this.emitContextCompaction(payload),
      compactPromise: () => this.compactPromise,
      setCompactPromise: (promise) => {
        this.compactPromise = promise;
      },
      compactAbortController: () => this.compactAbortController,
      setCompactAbortController: (controller) => {
        this.compactAbortController = controller;
      },
      setPrompt: () => this.setPrompt(),
      prompt: () => this.prompt(),
    };
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
    // The new array produced by filter is enough: message objects are immutable once enqueued, and
    // the store runs cloneMessages itself.
    const conversation = this.conversation.filter(
      (message) => message.metadata?.promptBlock !== "session-gap-reminder",
    );
    this.sessionSave = this.sessionSave.then(async () => {
      try {
        if (
          this.sessionGeneration !== sessionGeneration ||
          this.taskGeneration !== taskGeneration ||
          this.currentSession?.id !== sessionId
        )
          return;
        const latest = this.sessionStore.find(sessionId) ?? session;
        const autoNamed = isAutomaticSessionName(latest);
        const titleSource = latest.titleSource ?? (autoNamed ? "local" : "manual");
        const name = displaySessionName(
          {
            name: titleSource === "local" ? (view?.name ?? latest.name) : latest.name,
            messages: view?.messages ?? latest.messages,
            autoNamed,
            titleSource,
            ...(latest.archiveTitle ? { archiveTitle: latest.archiveTitle } : {}),
          },
          this.sessionTitleMode(),
        );
        const updated = await this.sessionStore.update(sessionId, {
          ...(view
            ? { name, autoNamed, titleSource, messages: view.messages, history: view.history }
            : { name, autoNamed, titleSource }),
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

  private async loadWorkspaceFiles(query: string): Promise<string[]> {
    return this.workspaceFileIndex.search(query, 200);
  }

  private async onEvent(event: RuntimeEvent): Promise<void> {
    this.runtimeEventSink?.(event);
    if (event.type === "assistant_end") this.latestUsage = { ...event.usage };
    this.debugTracker.track(event);
    if (event.type === "context_compaction") {
      this.writeDebugLog(
        JSON.stringify({
          event: "context_compaction",
          phase: event.phase,
          reason: event.reason,
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
          replacementCount: event.replacementCount,
          message: event.message,
        }),
      );
    }
    if (event.type === "plan_complete") {
      const sessionId = this.currentSession?.id ?? "session-current";
      this.pendingPlanExecute = {
        sessionId,
        plan: event.plan,
        prompt: buildPlanExecutePrompt(event.plan),
      };
      if (this.permissionMode === "plan") {
        this.permissionMode = this.handlers.permissionModeAfterPlan();
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
    // Streaming deltas do not trigger persistence; wait for a boundary event to write to disk.
    if (event.type !== "assistant_delta" && event.type !== "thought_delta") this.scheduleTuiSessionPersist();
  }

  private scheduleTuiSessionPersist(): void {
    if (this.sessionPersistTimer) return;
    this.sessionPersistTimer = setTimeout(() => {
      this.sessionPersistTimer = undefined;
      // The timed persistence writes only metadata and the session; the TUI snapshot is written by
      // explicit calls (session switch/exit, etc.), avoiding repeated serialization of the whole
      // transcript during streaming.
      void this.persistTuiSession(false);
    }, 250);
  }

  private async flushBackgroundNotifications(): Promise<void> {
    if (this.taskRunning()) return;
    const runtime = this.agentRuntime;
    if (!runtime) return;
    const { backgroundTaskNotification } = await loadSubagentBackground();
    const { shellJobNotification, shellJobs } = await loadShellJobs();
    const notifications = [
      ...runtime.backgroundAgents.drainNotifications().map(backgroundTaskNotification),
      ...shellJobs().drainNotifications().map(shellJobNotification),
    ];
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
    return this.approvalQueue.hasPending();
  }

  private requestApproval(
    call: ToolCall,
    level: number,
    description: string,
    origin: SubagentOrigin,
    requestId: string,
  ): Promise<ApprovalResponse> {
    return this.approvalQueue.request(call, level, description, origin, requestId);
  }

  private cancelApprovalsForOrigin(origin: SubagentOrigin): void {
    this.approvalQueue.cancelForOrigin(origin);
  }

  private async requestUserQuestions(questions: readonly QuestionItem[]): Promise<Record<string, string>> {
    if (this.renderer.question) {
      const answers = await this.renderer.question(questions);
      if (answers) return answers;
    }
    const fallback: Record<string, string> = {};
    for (const q of questions) {
      fallback[q.question] = q.options[0]?.label ?? "Yes";
    }
    return fallback;
  }

  private resolveApproval(value: string): void {
    this.approvalQueue.resolveFromInput(value);
  }

  private async handleCommand(value: string): Promise<void> {
    await this.commandRouter.dispatch(value);
  }

  private async handleSkillCommand(commandName: string, argument: string): Promise<void> {
    const name = commandName.replace(/^\//, "");
    const skill = await this.skillLoader.get(name);
    if (!skill) {
      this.renderer.error(`Skill not found: ${name}`);
      return;
    }

    await this.ensureMcpReady();
    const registry = await this.buildToolRegistry({ skillTools: true });
    try {
      assertSkillTools(
        skill,
        registry.list().map((tool) => tool.name),
      );
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
          assertSkillTools(
            skill,
            registry.list().map((tool) => tool.name),
          );
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
      kind: "write",
      maxOutputChars: 8_000,
      invoke: async (call) => {
        const source = typeof call.arguments.source === "string" ? call.arguments.source.trim() : "";
        const name = typeof call.arguments.name === "string" ? call.arguments.name.trim() : undefined;
        if (!source)
          return { ok: false, output: "", error: "Skill source is required.", summary: "skill installation failed" };
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

  /** Unified registry construction: builtin tools stay resident; MCP/Skill system tools are loaded
   *  on demand. */
  private async buildToolRegistry(
    options: { skillTools?: boolean; mcp?: "always" | "if-started" | "never" } = {},
  ): Promise<ToolRegistry> {
    const { ToolRegistry, registerBuiltinTools } = await loadTools();
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, this.workspace);
    const mcp = options.mcp ?? "always";
    if (mcp === "always" || (mcp === "if-started" && this.mcp.started)) {
      if (mcp === "if-started") await this.ensureMcpReady();
      this.registerMcpTools(registry);
    }
    if (options.skillTools) this.registerSkillSystemTools(registry);
    return registry;
  }

  private registerMcpTools(registry: ToolRegistry): void {
    this.mcp.registerTools(registry);
  }

  private async toolSchemasForCurrentMode(registry: ToolRegistry): Promise<Record<string, unknown>[]> {
    const { isPlanModeTool } = await loadTools();
    return registry.schemas((tool) => {
      if (this.workMode === "plan" && !isPlanModeTool(tool)) return false;
      return !this.mcp.isMcpTool(tool.name) || this.mcp.isActivated(tool.name);
    });
  }

  private startMcpConnections(): void {
    this.mcp.start();
  }

  private async ensureMcpReady(): Promise<void> {
    await this.mcp.ensureReady();
  }

  private activeSkillReminders(): readonly string[] {
    return [...this.activeSkills.values()].map(({ definition, prompt }) =>
      this.formatActiveSkillReminder(definition.name, prompt),
    );
  }

  private formatActiveSkillReminder(name: string, prompt: string): string {
    return `<active-skill name="${name}">\n${prompt}\n</active-skill>`;
  }

  /**
   * Conversation-level rewind (`/rewind [N]`).
   *
   * Semantic boundaries:
   * - It truncates the **conversation history** only (what the model sees); file changes remain the job
   *   of `/undo`, and the two do not replace each other;
   * - The cut point falls before a user turn, so the 1:1 pairing of assistant tool calls with tool
   *   results is naturally preserved;
   * - The archive-level truncation goes through the session store's existing `session-reset` path, and
   *   the raw JSONL bytes are kept for auditing;
   * - Only turns after the compaction boundary can be rewound: earlier conversation has been folded
   *   into a summary, and the original text is no longer in the active history.
   */
  /**
   * /resume: continues a task paused by the progress gate. It hands the goal fingerprint from the
   * paused state to the new task, so the new task keeps that run's window, phase and already-written
   * files (see resumedRunState) while the gate is turned off -- exactly what the pause notice promised.
   */
  private async resumeProgressTask(): Promise<{ ok: boolean; output: string }> {
    if (!this.model) return { ok: false, output: "no model selected; use /model PROVIDER/MODEL first" };
    const state = await new ProgressStateStore(this.workspace).load().catch(() => undefined);
    const stop = state?.stop;
    if (!state || (stop?.kind !== "blocked" && stop?.kind !== "stopped_by_budget")) {
      return {
        ok: false,
        output: "No paused task to resume: use /resume after a progress gate or the token budget pauses one.",
      };
    }
    const prompt =
      "Continue the task that was paused, from where it stopped. The progress gate is disarmed for the rest of this run.";
    this.renderer.user(prompt);
    this.setPrompt();
    this.launchTask(prompt, true, false, false, undefined, { resumeGoal: state.goalFingerprint });
    return { ok: true, output: "Resuming the paused task; the progress gate is off for this run." };
  }

  private async rewindConversation(argument: string): Promise<{ ok: boolean; output: string }> {
    const indices = userTurnIndices(this.conversation);
    if (!indices.length) return { ok: false, output: "This session has no user messages to rewind to." };
    const tokens = argument.trim().split(/\s+/).filter(Boolean);
    const withFiles = tokens.includes("--files");
    const requested = tokens.find((token) => !token.startsWith("--")) ?? "";
    if (withFiles && !requested) {
      return { ok: false, output: "Usage: /rewind N --files (N is required when reverting files)." };
    }
    if (!requested) {
      const listing = indices
        .map((index, position) => `${position + 1}. ${summarizeUserTurn(this.conversation[index]?.content ?? "")}`)
        .join("\n");
      return {
        ok: true,
        output: [
          "Rewind targets (run /rewind N to drop everything from that turn onward):",
          listing,
          "Add --files to also revert the files changed by those turns (refused when Git HEAD or later edits make it unsafe).",
        ].join("\n"),
      };
    }
    const target = Number.parseInt(requested, 10);
    if (!Number.isInteger(target) || target < 1 || target > indices.length) {
      return {
        ok: false,
        output: `Invalid rewind target: ${requested}. Use a number between 1 and ${indices.length}.`,
      };
    }
    const cut = indices[target - 1]!;
    if (cut === 0) return { ok: false, output: "Already at the beginning of this session; nothing to rewind." };

    let filesNote = "";
    if (withFiles) {
      const sessionId = this.currentSession?.id;
      const taskId = this.conversation[cut]?.metadata?.taskId;
      if (!sessionId) return { ok: false, output: "No active session is available for the file rewind." };
      if (typeof taskId !== "string" || !taskId) {
        return {
          ok: false,
          output:
            "File rewind is unavailable for that turn: it has no snapshot link (session recorded before this feature). " +
            "The conversation was left untouched; use /undo for the latest batch.",
        };
      }
      const runtime = await this.ensureAgentRuntime();
      const files = await runtime.snapshotStore.restoreBefore(sessionId, taskId);
      if (!files.ok) {
        return { ok: false, output: `File rewind refused; the conversation was left untouched. ${files.output}` };
      }
      filesNote = ` ${files.output}`;
    }

    const removed = this.conversation.length - cut;
    this.conversation = this.conversation.slice(0, cut);
    (await this.currentContextManager()).reset();
    this.tui?.rewindToUserMessage(target);
    this.refreshTui();
    await this.persistTuiSession();
    return {
      ok: true,
      output:
        `Rewound the conversation to before user turn ${target}; ${removed} message(s) removed.` +
        (withFiles
          ? filesNote
          : " Files changed by those turns are NOT reverted — run /rewind N --files, or /undo for the latest batch."),
    };
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

  private async runTui(
    history: readonly string[],
    prewarmedInk?: Promise<typeof import("./tui/ink-app.js")>,
  ): Promise<void> {
    const isRunning = (): boolean => this.interactionRunning() || this.hasPendingApprovals();
    const { InkTuiApp } = await (prewarmedInk ?? loadInkApp());
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
      onModelSelected: (reference) => this.handlers.handleModel(reference),
      loadRemoteModels: async (baseURL, apiKey, protocol) => {
        const { fetchRemoteModels } = await import("./provider.js");
        const remote = await fetchRemoteModels(baseURL, apiKey, protocol);
        return remote.map((model): ConnectModelOption => {
          const next: ConnectModelOption = { id: model.id, selected: false };
          if (model.contextWindow !== undefined) next.contextWindow = model.contextWindow;
          return next;
        });
      },
      onConnect: async (input) => this.handlers.applyConnectProvider(input),
      loadProviders: async () => {
        const fresh = await loadConfig(this.workspace);
        return Object.entries(fresh.providers).map(([name, profile]) => ({
          name,
          baseURL: profile.options.baseUrl ?? "",
          protocol: resolveProviderProtocolFor(name, profile.options),
          modelCount: Object.keys(profile.models).length,
          isCurrent: this.model?.provider === name,
        }));
      },
      onProviderSelected: (name) => this.handlers.handleConnect(name),
      onProviderDeleted: (name) => this.handlers.handleProviderDelete(name),
      loadSessions: () => this.crud.loadSessionOptions(),
      onSessionSelected: (id) => this.crud.selectSession(id),
      onSessionCreated: (name) => this.crud.createSession(name),
      onSessionDeleted: (id) => this.crud.deleteSession(id),
      loadFollowUps: () => this.loadFollowUpOptions(),
      onFollowUpCancelled: (id) => this.cancelFollowUp(id),
      loadFiles: (query) => this.loadWorkspaceFiles(query),
      onSessionChanged: () => this.persistTuiSession(),
      getFollowUpCount: () => this.followUps.length,
      getBackgroundTasks: async () => {
        const subagents =
          this.agentRuntime?.backgroundAgents.list().map((task) => ({
            id: task.id,
            name: task.name,
            origin: task.origin,
            definitionName: task.definitionName,
            status: task.status,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            error: task.error,
            output: task.output,
          })) ?? [];
        const { shellJobs, formatJobOutput } = await loadShellJobs();
        const jobs = shellJobs()
          .list()
          .map((job) => ({
            id: job.id,
            name: job.command,
            kind: "job" as const,
            status: tuiJobStatus(job.status),
            startedAt: job.startedAt,
            ...(job.stdout || job.stderr ? { output: formatJobOutput(job) } : {}),
            ...(job.endedAt ? { endedAt: job.endedAt } : {}),
            ...(job.error ? { error: job.error } : {}),
          }));
        return [...subagents, ...jobs];
      },
      getSessionName: () => (this.currentSession ? this.sessionName(this.currentSession) : "Current session"),
      getApprovalPolicy: () => (this.permissionMode === "bypass" ? "all" : "ask"),
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
          this.permissionMode =
            this.permissionMode === "plan" ? this.handlers.permissionModeAfterPlan() : this.permissionMode;
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
      getContextEstimate: () => {
        const session = this.currentSession;
        if (!session) return undefined;
        const manager = this.contextManagers.get(session.id);
        return manager ? manager.estimateTokens(this.conversation, []) : undefined;
      },
      getModelReference: () => (this.model ? this.modelReference(this.model) : this.currentSession?.modelReference),
      getModelWarning: () => this.modelWarning,
      isInteractionBlocked: () =>
        this.interactionRunning() || this.hasPendingApprovals() || this.pendingPlanExecute !== undefined,
      history: this.currentSession?.history ?? history,
      ...(this.currentSession ? { initialSession: this.crud.toSessionView(this.currentSession) } : {}),
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
        const result = await execAsync(command, {
          cwd: this.workspace,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          signal: abortController.signal,
        });
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
          this.renderer.error(
            `shell command failed (exit ${String(item.code ?? "unknown")})${output ? `\n${output}` : ""}`,
          );
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
    if (this.taskRunning() || this.approvalQueue.hasPendingForMainOrigin()) {
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
    this.memoryExtraction.schedule(sessionId, messages, model);
  }

  private complete(line: string, callback: (error: Error | null, result?: CompleterResult) => void): void {
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

  /** Serializes session write operations; a task exception is swallowed and undefined is returned. */
  private runSerialSessionWrite<T>(task: () => Promise<T>): Promise<T | undefined> {
    let value: T | undefined;
    this.sessionSave = this.sessionSave
      .then(async () => {
        value = await task();
      })
      .catch(() => undefined);
    return this.sessionSave.then(() => value);
  }

  private scheduleModelSessionTitle(sessionId: string, model: ModelConfig): void {
    this.titles.schedule(sessionId, model);
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
      await Promise.all([runtime.backgroundAgents.restore(), runtime.teams.restore()]);
      await this.sweepOrphanWorktrees();
    })();
    await this.agentStateRestore;
  }

  /** Reclaims worktrees left behind by a crash and referenced by no task lease (best-effort). */
  private async sweepOrphanWorktrees(): Promise<void> {
    const runtime = this.agentRuntime;
    if (!runtime) return;
    const protectedSlugs = new Set<string>();
    for (const task of runtime.backgroundAgents.list()) {
      if (task.worktreeLease) protectedSlugs.add(task.worktreeLease.slug);
    }
    for (const team of runtime.teams.list()) {
      for (const lease of team.worktreeLeases) protectedSlugs.add(lease.slug);
    }
    const removed = await sweepOrphanWorktrees(this.workspace, protectedSlugs).catch(() => [] as readonly string[]);
    for (const slug of removed) this.renderer.status(`Reclaimed orphan worktree: ${slug}`, "cyan");
  }

  private writeDebugLog(message: string): void {
    this.debugLogSink(message);
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
    this.titles.abortAll();
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
    await this.titles.waitForIdle();
    await this.memoryExtraction.init()?.catch(() => undefined);
    while (await this.memoryExtraction.hasPendingJobs()) {
      await this.memoryExtraction.waitForJobs();
    }
    await this.memoryExtraction.waitForExtractorIdle();
    await this.mcp.close();
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
    // Dispatch the process_exit hook before the process exits (rules carry their own timeout;
    // failures are only logged).
    if (this.hookEngine) {
      try {
        await this.hookEngine.dispatch({ event: "process_exit", workspace: this.workspace });
      } catch {
        // A hook failure must not block exit
      }
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
      return event.state === "planning" ||
        event.state === "executing" ||
        event.state === "verifying" ||
        event.state === "awaiting_approval"
        ? "boundary"
        : "normal";
    default:
      return "normal";
  }
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

function tokenValue(usage: Readonly<Record<string, number>>, ...keys: string[]): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
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

/** Maps a shell job status onto the TUI's background-task status vocabulary (aligned with the
 *  subagent state machine). */
function tuiJobStatus(status: "running" | "exited" | "failed" | "killed"): string {
  if (status === "exited") return "completed";
  if (status === "killed") return "cancelled";
  return status;
}

/** One-line summary for the /rewind listing: strips the "User message:" wrapper, flattens
 *  whitespace, and truncates to a single line. */
function summarizeUserTurn(content: string): string {
  const withoutPrefix = content.includes("User message:\n")
    ? content.slice(content.indexOf("User message:\n"))
    : content;
  const flattened = withoutPrefix
    .replace(/^User message:\n?/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened) return "(empty prompt)";
  return flattened.length > 80 ? `${flattened.slice(0, 79)}…` : flattened;
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
