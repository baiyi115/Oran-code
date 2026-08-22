import type { Message, ModelConfig, ToolCall, ToolDefinition, ToolResult } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import { BackgroundAgentTaskManager } from "./background.js";
import { containsForkMarker, forkPrompt, SubagentRunner } from "./runner.js";
import type { AgentDefinitionLoader } from "./roles.js";
import type { StructuredSubagentScope } from "./scope.js";
import { TeamManager } from "./team.js";
import type { AgentToolArguments, SubagentOrigin } from "./types.js";

export interface SubagentCoordinatorOptions {
  readonly roles: AgentDefinitionLoader;
  readonly runner: SubagentRunner;
  readonly background: BackgroundAgentTaskManager;
  readonly teams: TeamManager;
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
    registry.register(this.taskStopTool());
    registry.register(this.taskRetryTool());
  }

  private agentTool(): ToolDefinition {
    const roleNames = this.options.roles.list().map((definition) => definition.name);
    return {
      name: "agent",
      description: "Delegate a bounded task to a predefined subagent, a context Fork, or a persistent teammate.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string", description: "Short task label shown in the UI." },
          prompt: { type: "string", description: "Complete task instructions for the subagent." },
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
      maxOutputChars: 16_000,
      invoke: (call, context) => this.invokeAgent(call, context?.signal),
    };
  }

  private async invokeAgent(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const args = parseAgentArguments(call.arguments);
    if (!args) return failed("invalid agent arguments: description and prompt are required strings");
    let model: ModelConfig | undefined;
    try {
      model = args.model ? this.options.resolveModel(args.model) : undefined;
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    if (args.team_name) {
      const definition = args.subagent_type ? this.options.roles.get(args.subagent_type) : undefined;
      if (args.subagent_type && !definition) return this.unknownRole(args.subagent_type);
      const spawned = this.options.teams.spawn(args.team_name, args.description, args.prompt, {
        ...(definition ? { definition } : {}),
        ...(model ? { model } : {}),
      });
      return spawned.ok ? success(spawned.output) : failed(spawned.output);
    }
    if (args.subagent_type) {
      const definition = this.options.roles.get(args.subagent_type);
      if (!definition) return this.unknownRole(args.subagent_type);
      const runOptions = {
        description: args.description,
        prompt: args.prompt,
        origin: { kind: "definition", name: definition.name } as const,
        definition,
        ...(model ? { model } : {}),
        background: args.run_in_background === true || definition.forceBackground === true,
      };
      if (runOptions.background) {
        const task = this.options.background.start(this.options.runner, runOptions);
        return success(`Started background subagent ${task.id} (name="${task.name}"). The result will arrive as a task notification.`);
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
    const runOptions = {
      description: args.description,
      prompt: forkPrompt(args.prompt),
      origin: { kind: "fork", name: args.description } as const,
      parentConversation: parent,
      ...(model ? { model } : {}),
      background: true,
    };
    if (this.options.scope) {
      const task = this.options.scope.start(runOptions);
      if ("code" in task) return failed(JSON.stringify(task));
      return success(`Started Fork ${task.id} (name="${task.name}"). It will be joined before the parent run returns.`);
    }
    const task = this.options.background.start(this.options.runner, runOptions);
    return success(`Started Fork ${task.id} (name="${task.name}"). The result will arrive as a task notification.`);
  }

  private teamCreateTool(): ToolDefinition {
    return simpleTool("team_create", "Create an in-memory teammate team.", { team_name: { type: "string" } }, ["team_name"], async (args) => {
      const result = this.options.teams.create(stringArg(args.team_name));
      return result.ok ? success(result.output) : failed(result.output);
    });
  }

  private teamSpawnTool(): ToolDefinition {
    return simpleTool("team_spawn", "Spawn a persistent teammate and assign its first task.", {
      team_name: { type: "string" }, description: { type: "string" }, prompt: { type: "string" },
      subagent_type: { type: "string" }, model: { type: "string" },
    }, ["team_name", "description", "prompt"], async (args) => {
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
      const result = this.options.teams.spawn(stringArg(args.team_name), stringArg(args.description), stringArg(args.prompt), {
        ...(definition ? { definition } : {}), ...(model ? { model } : {}),
      });
      return result.ok ? success(result.output) : failed(result.output);
    });
  }

  private teamSendTool(): ToolDefinition {
    return simpleTool("team_send", "Queue a message for a persistent teammate.", {
      team_name: { type: "string" }, member_name: { type: "string" }, prompt: { type: "string" },
    }, ["team_name", "member_name", "prompt"], async (args) => {
      const result = this.options.teams.send(stringArg(args.team_name), stringArg(args.member_name), stringArg(args.prompt));
      return result.ok ? success(result.output) : failed(result.output);
    });
  }

  private teamListTool(): ToolDefinition {
    return simpleTool("team_list", "List in-memory teams and teammate status.", {}, [], async () => success(JSON.stringify(this.options.teams.list(), null, 2)));
  }

  private teamDeleteTool(): ToolDefinition {
    return simpleTool("team_delete", "Delete a team and stop all teammates.", { team_name: { type: "string" } }, ["team_name"], async (args) => {
      const result = await this.options.teams.delete(stringArg(args.team_name));
      return result.ok ? success(result.output) : failed(result.output);
    });
  }

  private teamResumeTool(): ToolDefinition {
    return simpleTool("team_resume", "Resume an interrupted teammate and replay only its interrupted prompt.", {
      team_name: { type: "string" }, member_name: { type: "string" },
    }, ["team_name", "member_name"], async (args) => {
      const result = this.options.teams.resume(stringArg(args.team_name), stringArg(args.member_name));
      return result.ok ? success(result.output) : failed(result.output);
    });
  }

  private taskListTool(): ToolDefinition {
    return simpleTool("task_list", "List one-shot background subagent tasks.", {}, [], async () => success(JSON.stringify(
      this.options.background.list().map(({ promise: _promise, abortController: _abortController, ...task }) => task), null, 2,
    )));
  }

  private taskDetailTool(): ToolDefinition {
    return simpleTool("task_detail", "Show one background subagent task.", { task_id: { type: "string" } }, ["task_id"], async (args) => {
      const task = this.options.background.get(stringArg(args.task_id));
      if (!task) return failed(`Unknown background task ${stringArg(args.task_id)}.`);
      const { promise: _promise, abortController: _abortController, ...snapshot } = task;
      return success(JSON.stringify(snapshot, null, 2));
    });
  }

  private taskStopTool(): ToolDefinition {
    return simpleTool("task_stop", "Cancel a running background subagent task.", { task_id: { type: "string" } }, ["task_id"], async (args) => {
      const taskId = stringArg(args.task_id);
      return this.options.background.cancel(taskId)
        ? success(`Cancellation requested for ${taskId}.`)
        : failed(`Task ${taskId} is unknown or already finished.`);
    });
  }

  private taskRetryTool(): ToolDefinition {
    return simpleTool("task_retry", "Retry a finished or interrupted background task as a new task.", {
      task_id: { type: "string" },
    }, ["task_id"], async (args) => {
      const taskId = stringArg(args.task_id);
      const previous = this.options.background.get(taskId);
      if (!previous) return failed(`Unknown background task ${taskId}.`);
      const definition = previous.definitionName ? this.options.roles.get(previous.definitionName) : undefined;
      if (previous.definitionName && !definition) return failed(`Agent definition is not available: ${previous.definitionName}.`);
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
    });
  }

  private unknownRole(name: string): ToolResult {
    return failed(JSON.stringify({ code: "unknown_subagent_type", subagent_type: name, available: this.options.roles.list().map((item) => item.name) }));
  }
}

function simpleTool(name: string, description: string, properties: Record<string, unknown>, required: readonly string[], invoke: (args: Record<string, unknown>) => Promise<ToolResult>): ToolDefinition {
  return {
    name, description,
    parameters: { type: "object", additionalProperties: false, properties, required },
    permissionLevel: 0, kind: "readonly", maxOutputChars: 16_000,
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
  if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") return undefined;
  return { description, prompt, ...(subagentType ? { subagent_type: subagentType } : {}), ...(model ? { model } : {}), ...(value.run_in_background === true ? { run_in_background: true } : {}), ...(teamName ? { team_name: teamName } : {}) };
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
