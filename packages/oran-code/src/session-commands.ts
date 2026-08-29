import { exec } from "node:child_process";
import { promisify } from "node:util";
import { commandHelp, type CommandRegistry, type SlashCommand } from "./commands.js";
import { parseSlashCommand } from "./commands.js";
import type { PermissionMode } from "./types.js";
import type { SessionRenderer } from "./renderer.js";
import type { SessionView } from "./tui/types.js";

const execAsync = promisify(exec);

export interface McpStatusSnapshot {
  readonly servers: readonly { name: string; toolCount: number }[];
  readonly failures: readonly { name: string; error: string }[];
  readonly toolCount: number;
}

export interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly definitionName?: string | undefined;
  readonly error?: string | undefined;
  readonly output?: string | undefined;
}

/**
 * 命令路由与 TerminalSession 之间的端口。session 保留全部执行能力
 * (任务、会话、模型、MCP、快照),router 只做解析、分发与纯本地输出。
 */
export interface SessionCommandContext {
  readonly workspace: string;
  readonly renderer: () => SessionRenderer;
  initializeCommandIntegrations(): Promise<void>;
  commands(): CommandRegistry;
  recordCommandUsage(name: string): void;
  handleSkillCommand(name: string, argument: string): Promise<void>;
  submitUserPrompt(prompt: string): Promise<void>;
  interactionRunning(): boolean;
  hasPendingApprovals(): boolean;
  runIsolatedSkill(prompt: string): Promise<void>;
  createSession(name?: string): Promise<SessionView | undefined>;
  handleModel(argument: string): Promise<void>;
  handleConnect(argument: string): Promise<void>;
  handleSessionCommand(argument: string): Promise<void>;
  handlePermissionCommand(argument: string): Promise<void>;
  changePermissionMode(mode: PermissionMode): Promise<void>;
  runManualCompaction(): Promise<void>;
  clearTranscript(): Promise<void>;
  renameSession(id: string, name: string): Promise<SessionView | undefined>;
  currentSessionId(): string | undefined;
  undoLatestChanges(): Promise<{ ok: boolean; output: string }>;
  requestExit(): void;
  /** /status 与 /mcp 的共享视图;调用方负责先确保 MCP 就绪。 */
  mcpStatus(): Promise<McpStatusSnapshot>;
  toolCountForCurrentMode(): Promise<number>;
  usageSummary(): { inputTokens?: number; outputTokens?: number };
  permissionMode(): PermissionMode;
  longTermMemory(): string | undefined;
  clearLongTermMemory(): void;
  skillList(): readonly { name: string; description: string }[];
  modelLabel(): string;
  backgroundTasks(): Promise<readonly BackgroundTaskSnapshot[]> | readonly BackgroundTaskSnapshot[];
}

/**
 * slash 命令路由:解析 → 分类(skill/prompt/isolated/local/ui action)→
 * 经端口分发。从 TerminalSession.handleCommand 提取,行为保持不变。
 */
export class SessionCommandRouter {
  constructor(private readonly ctx: SessionCommandContext) {}

  async dispatch(value: string): Promise<void> {
    await this.ctx.initializeCommandIntegrations();
    const parsed = parseSlashCommand(value);
    if (!parsed) return;
    const command = this.ctx.commands().get(parsed.name);
    if (!command) {
      this.ctx.renderer().error(`Unknown command: ${parsed.name}. Use /help.`);
      return;
    }
    this.ctx.recordCommandUsage(command.name);
    const { name } = command;
    const { argument } = parsed;

    if (command.description.endsWith("[skill]")) {
      await this.ctx.handleSkillCommand(name, argument);
      return;
    }

    if (command.kind === "prompt") {
      const prompt = command.handler ? await command.handler(argument) : argument;
      if (!prompt.trim()) this.ctx.renderer().error(`Command ${name} did not produce a prompt.`);
      else await this.ctx.submitUserPrompt(prompt);
      return;
    }
    if (command.kind === "isolated-skill") {
      if (this.ctx.interactionRunning() || this.ctx.hasPendingApprovals()) {
        this.ctx
          .renderer()
          .status("finish or cancel the current interaction before running an isolated skill", "yellow");
        return;
      }
      const prompt = command.handler ? await command.handler(argument) : argument;
      if (!prompt.trim()) {
        this.ctx.renderer().error(`Command ${name} did not produce a skill prompt.`);
        return;
      }
      this.ctx.renderer().user(`[isolated skill] ${name}${argument ? ` ${argument}` : ""}`);
      await this.ctx.runIsolatedSkill(prompt);
      return;
    }
    if (command.kind === "local") {
      const output = await this.localOutput(command, argument);
      this.ctx.renderer().markdown(name, output);
      return;
    }

    switch (command.action) {
      case "skills": {
        const output = await this.localOutput(command, argument);
        this.ctx.renderer().markdown(name, output);
        return;
      }
      case "new": {
        const session = await this.ctx.createSession(argument || undefined);
        if (session) this.ctx.renderer().status(`Started session ${session.name}.`, "cyan");
        return;
      }
      case "model":
        await this.ctx.handleModel(argument);
        return;
      case "connect":
        await this.ctx.handleConnect(argument);
        return;
      case "session":
        await this.ctx.handleSessionCommand(argument);
        return;
      case "permission":
        await this.ctx.handlePermissionCommand(argument);
        return;
      case "plan":
        if (argument) this.ctx.renderer().error("/plan does not accept arguments");
        else await this.ctx.changePermissionMode("plan");
        return;
      case "compact":
        if (argument) {
          this.ctx.renderer().error("/compact does not accept arguments");
          return;
        }
        await this.ctx.runManualCompaction();
        return;
      case "clear": {
        if (this.ctx.interactionRunning() || this.ctx.hasPendingApprovals()) {
          this.ctx.renderer().status("finish or cancel the current task before clearing the transcript", "yellow");
          return;
        }
        await this.ctx.clearTranscript();
        this.ctx.renderer().status("Transcript cleared.", "cyan");
        return;
      }
      case "rename": {
        const nameValue = argument.trim();
        if (!nameValue) {
          this.ctx.renderer().error("usage: /rename NAME");
          return;
        }
        const sessionId = this.ctx.currentSessionId();
        const session = sessionId ? await this.ctx.renameSession(sessionId, nameValue) : undefined;
        if (session) this.ctx.renderer().status(`Session renamed to ${session.name}.`, "cyan");
        else this.ctx.renderer().error("cannot rename the active session while a task is running");
        return;
      }
      case "undo": {
        if (argument) {
          this.ctx.renderer().error(`${name} does not accept arguments`);
          return;
        }
        if (this.ctx.interactionRunning() || this.ctx.hasPendingApprovals()) {
          this.ctx.renderer().status("finish or cancel the current task before undoing files", "yellow");
          return;
        }
        if (!this.ctx.currentSessionId()) {
          this.ctx.renderer().error("No active session is available for undo.");
          return;
        }
        const result = await this.ctx.undoLatestChanges();
        if (result.ok) this.ctx.renderer().status(result.output, "cyan");
        else this.ctx.renderer().error(result.output);
        return;
      }
      case "exit":
        this.ctx.requestExit();
        return;
      default:
        this.ctx.renderer().error(`Command ${name} has no UI action configured.`);
    }
  }

  private async localOutput(command: SlashCommand, argument: string): Promise<string> {
    switch (command.name) {
      case "/help": {
        const target = argument ? this.ctx.commands().get(argument) : undefined;
        if (argument && !target) return `Unknown command: ${argument}. Use /help.`;
        if (!target) return commandHelp(this.ctx.commands().list());
        const aliases = target.aliases?.length ? target.aliases.join(", ") : "(none)";
        const usage = target.usage ?? `${target.name}${target.argumentHint ? ` ${target.argumentHint}` : ""}`;
        return `${usage}\n${target.description}\nAliases: ${aliases}\nType: ${target.kind}`;
      }
      case "/status": {
        const usage = this.ctx.usageSummary();
        const mcp = await this.ctx.mcpStatus();
        const toolCount = await this.ctx.toolCountForCurrentMode();
        return [
          `permission: ${this.ctx.permissionMode()}`,
          `tokens.input: ${usage.inputTokens ?? 0}`,
          `tokens.output: ${usage.outputTokens ?? 0}`,
          `tools: ${toolCount}`,
          `mcp: ${mcp.servers.length} servers, ${mcp.toolCount} tools`,
          `memory.entries: ${countPromptEntries(this.ctx.longTermMemory())}`,
          `model: ${this.ctx.modelLabel()}`,
          `workspace: ${this.ctx.workspace}`,
        ].join("\n");
      }
      case "/memory": {
        if (argument.trim().toLowerCase() === "clear") {
          this.ctx.clearLongTermMemory();
          return "Loaded long-term memory cleared for subsequent tasks.";
        }
        if (argument) return "Usage: /memory [clear]";
        return this.ctx.longTermMemory()?.trim() || "No long-term memory is loaded.";
      }
      case "/skills": {
        if (argument) return "Usage: /skills";
        const skills = this.ctx.skillList();
        return skills.length
          ? ["Available Skills:", ...skills.map((skill) => `/${skill.name} — ${skill.description}`)].join("\n")
          : "No Skills were found in the built-in, user, or project Skill directories.";
      }
      case "/worktree": {
        try {
          const result = await execAsync("git worktree list --porcelain", {
            cwd: this.ctx.workspace,
            windowsHide: true,
          });
          return result.stdout.trim() || "No Git worktrees were reported.";
        } catch {
          return "Git worktree information is unavailable for this workspace.";
        }
      }
      case "/tasks":
      case "/subagents": {
        const tasks = await this.ctx.backgroundTasks();
        if (!tasks.length) return "No background subagent tasks found.";
        const lines: string[] = ["Background Subagent Tasks:"];
        for (const task of tasks) {
          const role = task.definitionName ? ` [${task.definitionName}]` : "";
          const start = Date.parse(task.startedAt);
          const end = task.endedAt ? Date.parse(task.endedAt) : Date.now();
          const duration = Number.isFinite(start) ? ` (${((end - start) / 1000).toFixed(1)}s)` : "";
          const icon =
            task.status === "completed" ? "✓" : task.status === "running" ? "⠋" : task.status === "queued" ? "⏳" : "✗";
          lines.push(`  ${icon} ${task.id}${role}: ${task.name} — ${task.status}${duration}`);
          if (task.error) {
            lines.push(`    Error: ${task.error.slice(0, 160)}`);
          } else if (task.output && (task.status === "completed" || task.status === "failed")) {
            const firstLine = task.output.trim().split("\n")[0] ?? "";
            if (firstLine) lines.push(`    Result: ${firstLine.slice(0, 140)}`);
          }
        }
        return lines.join("\n");
      }
      case "/mcp": {
        const mcp = await this.ctx.mcpStatus();
        if (!mcp.servers.length) {
          return mcp.failures.length
            ? ["No MCP servers are connected.", ...mcp.failures.map((item) => `- ${item.name}: ${item.error}`)].join(
                "\n",
              )
            : "No MCP servers are connected.";
        }
        return [
          ...mcp.servers.map((server) => `- ${server.name}: ${server.toolCount} tools`),
          `Total: ${mcp.servers.length} servers, ${mcp.toolCount} tools`,
          ...(mcp.failures.length ? ["Failed:", ...mcp.failures.map((item) => `- ${item.name}: ${item.error}`)] : []),
        ].join("\n");
      }
      default:
        return command.handler
          ? await command.handler(argument)
          : `Command ${command.name} has no local handler configured.`;
    }
  }
}

function countPromptEntries(value: string | undefined): number {
  return value?.split(/\r?\n/).filter((line) => line.trim().length > 0).length ?? 0;
}
