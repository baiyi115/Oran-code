import type { Message, ModelConfig, ToolCall, ToolDefinition, ToolResult } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { BackgroundAgentTaskManager } from "./background.js";
import { formatAgentMessage, type AgentMessageBus } from "./messages.js";
import { containsForkMarker, forkPrompt, SubagentRunner } from "./runner.js";
import type { AgentDefinitionLoader } from "./roles.js";
import type { StructuredSubagentScope } from "./scope.js";
import { TeamManager } from "./team.js";
import type { AgentToolArguments, DelegatedTaskContract, SubagentOrigin } from "./types.js";

const DEFAULT_GUIDANCE_WAIT_SECONDS = 60;
const MAX_GUIDANCE_WAIT_SECONDS = 300;

export interface SubagentCoordinatorOptions {
  readonly roles: AgentDefinitionLoader;
  readonly runner: SubagentRunner;
  readonly background: BackgroundAgentTaskManager;
  readonly teams: TeamManager;
  readonly messages?: AgentMessageBus;
  readonly getParentSessionId?: () => string | undefined;
  readonly parentConversation?: () => readonly Message[];
  readonly scope?: StructuredSubagentScope;
  readonly resolveModel: (reference: string) => ModelConfig;
  readonly callerOrigin?: SubagentOrigin;
}

export class SubagentCoordinator {
  constructor(private readonly options: SubagentCoordinatorOptions) {}

  registerTools(registry: ToolRegistry): void {
    this.options.teams.attachRuntime({
      runner: this.options.runner,
      resolveDefinition: (name) => this.options.roles.get(name),
      resolveModel: this.options.resolveModel,
      ...(this.options.getParentSessionId ? { getParentSessionId: this.options.getParentSessionId } : {}),
    });
    registry.register(this.agentTool());
    registry.register(this.teamCreateTool());
    registry.register(this.teamSpawnTool());
    registry.register(this.teamSendTool());
    registry.register(this.teamListTool());
    registry.register(this.teamDeleteTool());
    registry.register(this.teamResumeTool());
    registry.register(this.taskListTool());
    registry.register(this.taskDetailTool());
    registry.register(this.taskSendTool());
    registry.register(this.taskMessagesTool());
    registry.register(this.reportToParentTool());
    registry.register(this.taskStopTool());
    registry.register(this.taskRetryTool());
  }

  private agentTool(): ToolDefinition {
    const roleNames = this.options.roles.list().map((definition) => definition.name);
    return {
      name: "agent",
      description:
        "Delegate a bounded task to a predefined subagent, a context Fork, or a persistent teammate. Multiple synchronous agent calls in the same tool batch run concurrently; set run_in_background to receive a later task notification (or a joined result in headless runs).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string", description: "Short task label shown in the UI." },
          prompt: { type: "string", description: "Complete task instructions for the subagent." },
          task_contract: {
            type: "object",
            description: "Optional explicit assignment: objective, scope boundaries and completion criteria.",
            additionalProperties: false,
            properties: {
              objective: { type: "string" },
              boundaries: { type: "string" },
              done_when: { type: "string" },
            },
            required: ["objective", "boundaries", "done_when"],
          },
          subagent_type: {
            type: "string",
            description: `Predefined role name. Omit to create a Fork. Available roles: ${roleNames.join(", ") || "none"}.`,
            ...(roleNames.length ? { enum: roleNames } : {}),
          },
          model: { type: "string", description: "Optional configured model reference override." },
          run_in_background: { type: "boolean", default: false },
          team_name: { type: "string", description: "Spawn a persistent teammate in this team." },
        },
        required: ["description", "prompt"],
      },
      permissionLevel: 0,
      kind: "readonly",
      cacheable: false,
      maxOutputChars: 16_000,
      invoke: (call, context) => this.invokeAgent(call, context?.signal),
    };
  }

  private async invokeAgent(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const args = parseAgentArguments(call.arguments);
    if (!args) return failed("invalid agent arguments: description, prompt or task_contract");
    const parentSessionId = this.options.getParentSessionId?.();
    const assignment = assignedPrompt(args);
    let model: ModelConfig | undefined;
    try {
      model = args.model ? this.options.resolveModel(args.model) : undefined;
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    if (args.team_name) {
      const definition = args.subagent_type ? this.options.roles.get(args.subagent_type) : undefined;
      if (args.subagent_type && !definition) return this.unknownRole(args.subagent_type);
      const spawned = this.options.teams.spawn(args.team_name, args.description, assignment, {
        ...(definition ? { definition } : {}),
        ...(model ? { model } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      });
      return spawned.ok ? success(spawned.output) : failed(spawned.output);
    }
    if (args.subagent_type) {
      const definition = this.options.roles.get(args.subagent_type);
      if (!definition) return this.unknownRole(args.subagent_type);
      const runOptions = {
        description: args.description,
        prompt: assignment,
        origin: { kind: "definition", name: definition.name } as const,
        definition,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(model ? { model } : {}),
        background: args.run_in_background === true || definition.forceBackground === true,
      };
      if (runOptions.background) {
        if (this.options.scope) {
          const task = this.options.scope.start(runOptions);
          if ("code" in task) return failed(JSON.stringify(task));
          return success(
            `Started background subagent ${task.id} (name="${task.name}"). It will be joined before the parent run returns.`,
          );
        }
        const task = this.options.background.start(this.options.runner, runOptions);
        return success(
          `Started background subagent ${task.id} (name="${task.name}"). The result will arrive as a task notification.`,
        );
      }
      const result = await this.options.runner.run({
        ...runOptions,
        ...(signal ? { signal } : {}),
      });
      return result.status === "completed" ? success(result.output) : failed(result.error ?? result.output);
    }
    const parent = this.options.parentConversation?.();
    if (!parent) return failed("Fork requires parent conversation context.");
    if (this.options.callerOrigin?.kind === "fork" || containsForkMarker(parent)) {
      return failed("Cannot create a Fork from a Fork-derived subagent.");
    }
    const background = args.run_in_background === true;
    const runOptions = {
      description: args.description,
      prompt: forkPrompt(assignment, { messaging: background && Boolean(this.options.messages) }),
      origin: { kind: "fork", name: args.description } as const,
      parentConversation: parent,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(model ? { model } : {}),
      background,
    };
    if (!runOptions.background) {
      const result = await this.options.runner.run({
        ...runOptions,
        ...(signal ? { signal } : {}),
      });
      return result.status === "completed" ? success(result.output) : failed(result.error ?? result.output);
    }
    if (this.options.scope) {
      const task = this.options.scope.start(runOptions);
      if ("code" in task) return failed(JSON.stringify(task));
      return success(`Started Fork ${task.id} (name="${task.name}"). It will be joined before the parent run returns.`);
    }
    const task = this.options.background.start(this.options.runner, runOptions);
    return success(`Started Fork ${task.id} (name="${task.name}"). The result will arrive as a task notification.`);
  }

  private teamCreateTool(): ToolDefinition {
    return simpleTool(
      "team_create",
      "Create an in-memory teammate team.",
      { team_name: { type: "string" } },
      ["team_name"],
      async (args) => {
        const result = this.options.teams.create(stringArg(args.team_name));
        return result.ok ? success(result.output) : failed(result.output);
      },
    );
  }

  private teamSpawnTool(): ToolDefinition {
    return simpleTool(
      "team_spawn",
      "Spawn a persistent teammate and assign its first task.",
      {
        team_name: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
        model: { type: "string" },
      },
      ["team_name", "description", "prompt"],
      async (args) => {
        const type = optionalStringArg(args.subagent_type);
        const definition = type ? this.options.roles.get(type) : undefined;
        if (type && !definition) return this.unknownRole(type);
        let model: ModelConfig | undefined;
        try {
          const reference = optionalStringArg(args.model);
          model = reference ? this.options.resolveModel(reference) : undefined;
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error));
        }
        const parentSessionId = this.options.getParentSessionId?.();
        const result = this.options.teams.spawn(
          stringArg(args.team_name),
          stringArg(args.description),
          stringArg(args.prompt),
          {
            ...(definition ? { definition } : {}),
            ...(model ? { model } : {}),
            ...(parentSessionId ? { parentSessionId } : {}),
          },
        );
        return result.ok ? success(result.output) : failed(result.output);
      },
    );
  }

  private teamSendTool(): ToolDefinition {
    return simpleTool(
      "team_send",
      "Queue a message for a persistent teammate.",
      {
        team_name: { type: "string" },
        member_name: { type: "string" },
        prompt: { type: "string" },
      },
      ["team_name", "member_name", "prompt"],
      async (args) => {
        const result = this.options.teams.send(
          stringArg(args.team_name),
          stringArg(args.member_name),
          stringArg(args.prompt),
        );
        return result.ok ? success(result.output) : failed(result.output);
      },
    );
  }

  private teamListTool(): ToolDefinition {
    return simpleTool(
      "team_list",
      "List in-memory teams and teammate status.",
      {},
      [],
      async () => success(JSON.stringify(this.options.teams.list(), null, 2)),
      { cacheable: false },
    );
  }

  private teamDeleteTool(): ToolDefinition {
    return simpleTool(
      "team_delete",
      "Delete a team and stop all teammates.",
      { team_name: { type: "string" } },
      ["team_name"],
      async (args) => {
        const result = await this.options.teams.delete(stringArg(args.team_name));
        return result.ok ? success(result.output) : failed(result.output);
      },
    );
  }

  private teamResumeTool(): ToolDefinition {
    return simpleTool(
      "team_resume",
      "Resume an interrupted teammate and replay only its interrupted prompt.",
      {
        team_name: { type: "string" },
        member_name: { type: "string" },
      },
      ["team_name", "member_name"],
      async (args) => {
        const result = this.options.teams.resume(stringArg(args.team_name), stringArg(args.member_name));
        return result.ok ? success(result.output) : failed(result.output);
      },
    );
  }

  private taskListTool(): ToolDefinition {
    return simpleTool(
      "task_list",
      "List one-shot subagent tasks, including children joined in headless runs.",
      {},
      [],
      async () =>
        success(
          JSON.stringify(
            [...this.options.background.list(), ...(this.options.scope?.list() ?? [])].map(
              ({ promise: _promise, abortController: _abortController, ...task }) => task,
            ),
            null,
            2,
          ),
        ),
      { cacheable: false },
    );
  }

  private taskDetailTool(): ToolDefinition {
    return simpleTool(
      "task_detail",
      "Show one subagent task.",
      { task_id: { type: "string" } },
      ["task_id"],
      async (args) => {
        const taskId = stringArg(args.task_id);
        const task =
          this.options.background.get(taskId) ?? this.options.scope?.list().find((item) => item.id === taskId);
        if (!task) return failed(`Unknown background task ${taskId}.`);
        const { promise: _promise, abortController: _abortController, ...snapshot } = task;
        return success(JSON.stringify(snapshot, null, 2));
      },
      { cacheable: false },
    );
  }

  private taskSendTool(): ToolDefinition {
    return {
      name: "task_send",
      description:
        "Send guidance to a running or queued subagent task. Delivery occurs before its next model turn; this is not user authorization. Check task_messages for delivery status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { task_id: { type: "string" }, message: { type: "string" } },
        required: ["task_id", "message"],
      },
      permissionLevel: 0,
      system: true,
      kind: "readonly",
      cacheable: false,
      maxOutputChars: 16_000,
      invoke: async (call, context) => {
        if (context?.subagentTaskId) return failed("Only the parent agent can send task guidance.");
        if (!this.options.messages) return failed("Task messaging is unavailable.");
        const result = await this.options.messages.sendToChild(
          stringArg(call.arguments.task_id),
          stringArg(call.arguments.message),
          this.options.getParentSessionId?.(),
        );
        return result.ok ? success(result.output) : failed(result.output);
      },
    };
  }

  private taskMessagesTool(): ToolDefinition {
    return {
      name: "task_messages",
      description: "Inspect recent task messages and their queued, delivered or undeliverable status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
      permissionLevel: 0,
      system: true,
      kind: "readonly",
      cacheable: false,
      maxOutputChars: 16_000,
      invoke: async (call, context) => {
        if (context?.subagentTaskId) return failed("Only the parent agent can inspect task messages.");
        if (!this.options.messages) return failed("Task messaging is unavailable.");
        return success(
          JSON.stringify(
            await this.options.messages.history(stringArg(call.arguments.task_id), this.options.getParentSessionId?.()),
            null,
            2,
          ),
        );
      },
    };
  }

  private reportToParentTool(): ToolDefinition {
    return {
      name: "report_to_parent",
      description:
        "Report progress, a blocker, a question or a result to the delegating agent while you work. A question waits up to wait_seconds (default 60, max 300) for guidance and returns it. Reports do not authorize new actions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["progress", "blocked", "question", "result"] },
          message: { type: "string" },
          wait_seconds: {
            type: "number",
            minimum: 0,
            maximum: MAX_GUIDANCE_WAIT_SECONDS,
            description: "Kind=question only: how long to wait for parent guidance. Defaults to 60.",
          },
        },
        required: ["kind", "message"],
      },
      permissionLevel: 0,
      system: true,
      kind: "readonly",
      cacheable: false,
      maxOutputChars: 16_000,
      invoke: async (call, context) => {
        const taskId = context?.subagentTaskId;
        if (!taskId) return failed("Only a running subagent can report to its parent.");
        if (!this.options.messages) return failed("Task messaging is unavailable.");
        const kind = call.arguments.kind;
        if (kind !== "progress" && kind !== "blocked" && kind !== "question" && kind !== "result") {
          return failed("Invalid report kind.");
        }
        const waitSeconds = guidanceWaitSeconds(kind, call.arguments.wait_seconds);
        if (waitSeconds === undefined) {
          return failed(`wait_seconds must be a number between 0 and ${MAX_GUIDANCE_WAIT_SECONDS}.`);
        }
        const result = await this.options.messages.sendToParent(taskId, kind, stringArg(call.arguments.message));
        if (!result.ok || waitSeconds === 0) return result.ok ? success(result.output) : failed(result.output);
        const guidance = await this.options.messages.waitForChild(taskId, waitSeconds * 1000, context?.signal);
        if (context?.signal?.aborted) return success(`${result.output}\nGuidance wait was cancelled.`);
        if (!guidance.length) {
          return success(
            `${result.output}\nNo guidance arrived within ${waitSeconds}s; continue with your best judgment or report again.`,
          );
        }
        return success(`${result.output}\n\n${guidance.map(formatAgentMessage).join("\n\n")}`);
      },
    };
  }

  private taskStopTool(): ToolDefinition {
    return simpleTool(
      "task_stop",
      "Cancel a running or queued subagent task.",
      { task_id: { type: "string" } },
      ["task_id"],
      async (args) => {
        const taskId = stringArg(args.task_id);
        return this.options.background.cancel(taskId) || this.options.scope?.cancel(taskId)
          ? success(`Cancellation requested for ${taskId}.`)
          : failed(`Task ${taskId} is unknown or already finished.`);
      },
    );
  }

  private taskRetryTool(): ToolDefinition {
    return simpleTool(
      "task_retry",
      "Retry a finished or interrupted predefined background subagent. Forks require a new agent call.",
      {
        task_id: { type: "string" },
      },
      ["task_id"],
      async (args) => {
        const taskId = stringArg(args.task_id);
        const previous = this.options.background.get(taskId);
        if (!previous)
          return failed(
            this.options.scope?.list().some((task) => task.id === taskId)
              ? `Scoped task ${taskId} cannot be retried; start a new agent call.`
              : `Unknown background task ${taskId}.`,
          );
        if (previous.origin.kind === "fork")
          return failed(
            `Fork ${taskId} cannot be retried without its original parent context; start a new agent call.`,
          );
        const definition = previous.definitionName ? this.options.roles.get(previous.definitionName) : undefined;
        if (previous.definitionName && !definition)
          return failed(`Agent definition is not available: ${previous.definitionName}.`);
        let model: ModelConfig | undefined;
        try {
          model = previous.modelReference ? this.options.resolveModel(previous.modelReference) : undefined;
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error));
        }
        const retried = this.options.background.retry(taskId, this.options.runner, {
          ...(definition ? { definition } : {}),
          ...(model ? { model } : {}),
        });
        return retried
          ? success(`Retried ${taskId} as ${retried.id}.`)
          : failed(`Task ${taskId} is still running and cannot be retried.`);
      },
    );
  }

  private unknownRole(name: string): ToolResult {
    return failed(
      JSON.stringify({
        code: "unknown_subagent_type",
        subagent_type: name,
        available: this.options.roles.list().map((item) => item.name),
      }),
    );
  }
}

function simpleTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
  invoke: (args: Record<string, unknown>) => Promise<ToolResult>,
  options: { cacheable?: boolean } = { cacheable: false },
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: "object", additionalProperties: false, properties, required },
    permissionLevel: 0,
    kind: "readonly",
    ...(options.cacheable === undefined ? {} : { cacheable: options.cacheable }),
    maxOutputChars: 16_000,
    invoke: (call) => invoke(call.arguments),
  };
}

function parseAgentArguments(value: Record<string, unknown>): AgentToolArguments | undefined {
  const description = optionalStringArg(value.description);
  const prompt = optionalStringArg(value.prompt);
  if (!description || !prompt) return undefined;
  const subagentType = optionalStringArg(value.subagent_type);
  const model = optionalStringArg(value.model);
  const teamName = optionalStringArg(value.team_name);
  const taskContract = value.task_contract === undefined ? undefined : parseTaskContract(value.task_contract);
  if (value.task_contract !== undefined && !taskContract) return undefined;
  if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") return undefined;
  return {
    description,
    prompt,
    ...(taskContract ? { task_contract: taskContract } : {}),
    ...(subagentType ? { subagent_type: subagentType } : {}),
    ...(model ? { model } : {}),
    ...(value.run_in_background === true ? { run_in_background: true } : {}),
    ...(teamName ? { team_name: teamName } : {}),
  };
}

function parseTaskContract(value: unknown): DelegatedTaskContract | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const contract = value as Record<string, unknown>;
  const objective = optionalStringArg(contract.objective);
  const boundaries = optionalStringArg(contract.boundaries);
  const doneWhen = optionalStringArg(contract.done_when);
  if (
    !objective ||
    !boundaries ||
    !doneWhen ||
    Object.keys(contract).some((key) => !["objective", "boundaries", "done_when"].includes(key))
  )
    return undefined;
  return { objective, boundaries, done_when: doneWhen };
}

function assignedPrompt(args: AgentToolArguments): string {
  const contract = args.task_contract;
  if (!contract) return args.prompt;
  return [
    args.prompt,
    "",
    "Delegated task contract:",
    `Objective: ${contract.objective}`,
    `Boundaries: ${contract.boundaries}`,
    `Completion criteria: ${contract.done_when}`,
  ].join("\n");
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Questions wait by default; other report kinds return immediately unless explicitly told to wait. */
function guidanceWaitSeconds(kind: string, value: unknown): number | undefined {
  if (value === undefined) return kind === "question" ? DEFAULT_GUIDANCE_WAIT_SECONDS : 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_GUIDANCE_WAIT_SECONDS, Math.max(0, Math.floor(value)));
}

function stringArg(value: unknown): string {
  return optionalStringArg(value) ?? "";
}

function success(output: string): ToolResult {
  return { ok: true, output, summary: output.split(/\r?\n/, 1)[0]?.slice(0, 160) ?? "completed" };
}

function failed(error: string): ToolResult {
  return { ok: false, output: "", error, summary: error.slice(0, 160) };
}
