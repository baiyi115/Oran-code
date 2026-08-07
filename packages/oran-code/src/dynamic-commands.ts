import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { parse } from "yaml";
import { CommandRegistry, type SlashCommand } from "./commands.js";
import { compatibleUserDataPath, projectStateRoot } from "./paths.js";

type SlashCommandKind = SlashCommand["kind"];

const ARGUMENT_PLACEHOLDER = /\$ARGUMENTS|\{\{\s*(?:args|arguments)\s*\}\}/gi;
const COMMAND_KINDS = new Set<SlashCommandKind>(["local", "ui", "prompt", "isolated-skill"]);

export interface DynamicCommandSource {
  readonly scope: "user" | "project";
  readonly path: string;
}

export interface DynamicMarkdownCommand extends SlashCommand {
  readonly source: DynamicCommandSource;
  readonly handler: (argument: string) => string;
}

export interface DynamicCommandDirectories {
  readonly user: string;
  readonly project: string;
}

export interface LoadDynamicCommandsOptions {
  readonly workspace: string;
  readonly directories?: Partial<DynamicCommandDirectories>;
  readonly allowKindMetadata?: boolean;
}

export interface RegisterDynamicCommandsResult {
  readonly registered: readonly DynamicMarkdownCommand[];
  readonly skipped: readonly DynamicMarkdownCommand[];
}

interface CommandDocument {
  readonly description?: string;
  readonly argumentHint?: string;
  readonly aliases: readonly string[];
  readonly kind: SlashCommandKind;
  readonly body: string;
}

/**
 * Loads user commands first and then applies project commands as overrides.
 * Directory and file failures are isolated so one bad source cannot abort startup.
 */
export async function loadDynamicMarkdownCommands(
  options: LoadDynamicCommandsOptions,
): Promise<DynamicMarkdownCommand[]> {
  const directories = resolveCommandDirectories(options);
  const merged = new Map<string, DynamicMarkdownCommand>();

  for (const command of await loadLayer(directories.user, "user", options.allowKindMetadata === true)) merged.set(command.name, command);
  for (const command of await loadLayer(directories.project, "project", options.allowKindMetadata === true)) merged.set(command.name, command);

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Registers all non-conflicting dynamic commands while preserving existing entries. */
export async function registerDynamicMarkdownCommands(
  registry: CommandRegistry,
  options: LoadDynamicCommandsOptions,
): Promise<RegisterDynamicCommandsResult> {
  const registered: DynamicMarkdownCommand[] = [];
  const skipped: DynamicMarkdownCommand[] = [];
  for (const command of await loadDynamicMarkdownCommands(options)) {
    if (!registry.canRegister(command)) {
      skipped.push(command);
      continue;
    }
    registry.register(command);
    registered.push(command);
  }
  return { registered, skipped };
}

export function renderDynamicCommand(body: string, argument: string): string {
  const normalizedBody = body.trim();
  const normalizedArgument = argument.trim();
  ARGUMENT_PLACEHOLDER.lastIndex = 0;
  if (ARGUMENT_PLACEHOLDER.test(normalizedBody)) {
    ARGUMENT_PLACEHOLDER.lastIndex = 0;
    return normalizedBody.replace(ARGUMENT_PLACEHOLDER, normalizedArgument);
  }
  if (!normalizedArgument) return normalizedBody;
  if (!normalizedBody) return normalizedArgument;
  return `${normalizedBody}\n\n${normalizedArgument}`;
}

export function commandNameFromRelativePath(path: string): string | undefined {
  const extension = extname(path);
  const withoutExtension = extension ? path.slice(0, -extension.length) : path;
  const segments = withoutExtension
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase().replace(/\s+/g, "-").replace(/^[-:]+|[-:]+$/g, ""));
  if (segments.length === 0 || segments.some((segment) => !segment)) return undefined;
  return `/${segments.join(":")}`;
}

function resolveCommandDirectories(options: LoadDynamicCommandsOptions): DynamicCommandDirectories {
  return {
    user: options.directories?.user ?? compatibleUserDataPath("commands"),
    project: options.directories?.project ?? resolve(projectStateRoot(options.workspace), "commands"),
  };
}

async function loadLayer(root: string, scope: DynamicCommandSource["scope"], allowKindMetadata: boolean): Promise<DynamicMarkdownCommand[]> {
  const paths = await collectMarkdownFiles(root);
  const commands: DynamicMarkdownCommand[] = [];
  for (const path of paths) {
    const command = await loadFile(root, path, scope, allowKindMetadata);
    if (command) commands.push(command);
  }
  return commands;
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return paths;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collectMarkdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") paths.push(path);
  }
  return paths;
}

async function loadFile(
  root: string,
  path: string,
  scope: DynamicCommandSource["scope"],
  allowKindMetadata: boolean,
): Promise<DynamicMarkdownCommand | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;

  const name = commandNameFromRelativePath(relative(root, path));
  if (!name) return undefined;
  const document = parseCommandDocument(raw, allowKindMetadata);
  const handler = (argument: string): string => renderDynamicCommand(document.body, argument);
  return {
    name,
    description: document.description ?? "custom Markdown command",
    kind: document.kind,
    source: { scope, path },
    handler,
    ...(document.argumentHint ? { argumentHint: document.argumentHint } : {}),
    ...(document.aliases.length ? { aliases: document.aliases } : {}),
  };
}

function parseCommandDocument(raw: string, allowKindMetadata: boolean): CommandDocument {
  const source = raw.replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return defaultDocument(source);
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) return defaultDocument(source);

  try {
    const metadata = parse(lines.slice(1, closing).join("\n")) as unknown;
    if (!isRecord(metadata)) return defaultDocument(lines.slice(closing + 1).join("\n"));
    const description = stringValue(metadata.description);
    const argumentHint = stringValue(metadata["argument-hint"] ?? metadata.argumentHint);
    const aliases = aliasValues(metadata.aliases);
    const requestedKind = stringValue(metadata.kind)?.toLowerCase();
    const kind = allowKindMetadata && requestedKind && COMMAND_KINDS.has(requestedKind as SlashCommandKind)
      ? requestedKind as SlashCommandKind
      : "prompt";
    return {
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      aliases,
      kind,
      body: lines.slice(closing + 1).join("\n"),
    };
  } catch {
    return defaultDocument(source);
  }
}

function defaultDocument(body: string): CommandDocument {
  return { aliases: [], kind: "prompt", body };
}

function aliasValues(value: unknown): string[] {
  const values = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
