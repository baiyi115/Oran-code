import type { ModelConfig } from "./types.js";

export type SlashCommandAction = "clear" | "compact" | "do" | "exit" | "model" | "new"
  | "permission" | "plan" | "rename" | "session" | "skills" | "undo";

export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  readonly argumentHint?: string;
  readonly kind: "local" | "ui" | "prompt" | "isolated-skill";
  readonly hidden?: boolean;
  readonly handler?: (argument: string) => string | Promise<string>;
  readonly action?: SlashCommandAction;
}

export const DEFAULT_COMMANDS: readonly SlashCommand[] = [
  { name: "/clear", description: "clear the transcript", kind: "ui", action: "clear" },
  { name: "/code-review", description: "manage the local code-review team", kind: "local", argumentHint: "COMMAND", hidden: true },
  { name: "/compact", description: "compact conversation context", kind: "ui", action: "compact" },
  { name: "/do", description: "leave plan mode and execute the pending plan", kind: "ui", action: "do" },
  { name: "/exit", aliases: ["/quit"], description: "exit the session", kind: "ui", action: "exit" },
  { name: "/help", description: "show available slash commands", kind: "local" },
  { name: "/memory", description: "show loaded long-term memory", kind: "local" },
  { name: "/mcp", description: "show connected extension servers", kind: "local", hidden: true },
  { name: "/model", description: "select model", kind: "ui", action: "model" },
  { name: "/new", description: "start a new session", kind: "ui", action: "new" },
  { name: "/permission", description: "set advanced permission policy", argumentHint: "MODE", kind: "ui", action: "permission", hidden: true },
  { name: "/plan", description: "enter plan mode", kind: "ui", action: "plan" },
  { name: "/rename", description: "rename current session", argumentHint: "NAME", kind: "ui", action: "rename" },
  { name: "/undo", aliases: ["/rollback"], description: "undo the latest Agent file change batch", kind: "ui", action: "undo" },
  { name: "/session", description: "list or resume a session", usage: "/session [ID]", argumentHint: "ID", kind: "ui", action: "session" },
  { name: "/skills", description: "show available skills", kind: "local", action: "skills" },
  { name: "/status", description: "show current agent status", kind: "local" },
  { name: "/worktree", description: "show workspace status", kind: "local" },
];

export class CommandRegistry {
  private readonly byName = new Map<string, SlashCommand>();
  private readonly byAlias = new Map<string, SlashCommand>();

  constructor(commands: readonly SlashCommand[] = DEFAULT_COMMANDS) {
    for (const command of commands) this.register(command);
  }

  register(command: SlashCommand): void {
    const name = normalizeCommandName(command.name);
    const aliases = (command.aliases ?? []).map(normalizeCommandName);
    const keys = [name, ...aliases];
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate) throw new Error(`slash command conflict: ${duplicate}`);
    for (const key of keys) {
      if (this.byName.has(key) || this.byAlias.has(key)) throw new Error(`slash command conflict: ${key}`);
    }
    const normalized: SlashCommand = { ...command, name, ...(aliases.length ? { aliases: [...aliases] } : {}) };
    this.byName.set(name, normalized);
    for (const alias of aliases) this.byAlias.set(alias, normalized);
  }

  canRegister(command: Pick<SlashCommand, "name" | "aliases">): boolean {
    const keys = [normalizeCommandName(command.name), ...(command.aliases ?? []).map(normalizeCommandName)];
    return new Set(keys).size === keys.length
      && keys.every((key) => !this.byName.has(key) && !this.byAlias.has(key));
  }

  get(name: string): SlashCommand | undefined {
    const key = normalizeCommandName(name);
    return this.byName.get(key) ?? this.byAlias.get(key);
  }

  list(includeHidden = false): SlashCommand[] {
    return [...this.byName.values()]
      .filter((command) => includeHidden || !command.hidden)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((command) => ({ ...command, ...(command.aliases ? { aliases: [...command.aliases] } : {}) }));
  }

  complete(query: string): SlashCommand[] {
    const value = query.replace(/^\//, "").toLowerCase();
    const commands = this.list();
    if (!value) return commands;
    return commands.filter((command) => command.name.slice(1).toLowerCase().startsWith(value)
      || (command.aliases ?? []).some((alias) => alias.slice(1).toLowerCase().startsWith(value)));
  }
}

export const DEFAULT_COMMAND_REGISTRY = new CommandRegistry();

function normalizeCommandName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface ParsedCommand {
  readonly name: string;
  readonly argument: string;
}

export function parseSlashCommand(value: string): ParsedCommand | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const separator = trimmed.search(/\s/);
  if (separator < 0) return { name: trimmed.toLowerCase(), argument: "" };
  return {
    name: trimmed.slice(0, separator).toLowerCase(),
    argument: trimmed.slice(separator).trim(),
  };
}

export function commandHelp(commands: readonly SlashCommand[] = DEFAULT_COMMANDS): string {
  return [...commands].filter((command) => !command.hidden).sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => {
      const usage = command.usage ?? `${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
      return `  ${usage}  ${command.description}`;
    })
    .join("\n");
}

export function formatModelReference(model: Pick<ModelConfig, "provider" | "model">): string {
  return `${model.provider}/${model.model}`;
}

export function modelCandidates(
  providers: Record<string, { models: Record<string, unknown> }>,
): string[] {
  return Object.entries(providers)
    .flatMap(([provider, profile]) => Object.keys(profile.models).map((model) => `${provider}/${model}`))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Keep command completion independent from the session so it can be reused by
 * readline and the interactive TUI without a live terminal.
 */
export function completeInput(
  line: string,
  models: readonly string[],
  commands: readonly SlashCommand[] = DEFAULT_COMMANDS,
): [string[], string] {
  if (!line.startsWith("/")) return [[], line];

  const [commandToken, ...rest] = line.split(/\s+/);
  if (commandToken === undefined) return [[], line];
  const normalizedCommandToken = commandToken.toLowerCase();

  if (normalizedCommandToken === "/model" && (line.includes(" ") || rest.length > 0)) {
    const partial = rest.join(" ");
    const matches = models.filter((model) => model.startsWith(partial));
    return [matches, partial];
  }

  if (line.includes(" ")) return [[], line];
  const matches = commands
    .filter((command) => command.name.toLowerCase().startsWith(normalizedCommandToken)
      || (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(normalizedCommandToken)))
    .map((command) => command.name);
  return [matches, commandToken];
}
