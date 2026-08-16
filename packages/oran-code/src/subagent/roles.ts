import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDocument } from "yaml";
import { projectStateRoot, userDataRoot } from "../paths.js";
import { isPermissionMode } from "../types.js";
import { isRecord } from "../types.js";
import type { AgentDefinition, AgentDefinitionScope } from "./types.js";

const AGENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = Object.freeze([
  Object.freeze({
    name: "general",
    description: "General-purpose coding subagent for bounded implementation and analysis tasks.",
    prompt: "You are a focused coding subagent. Complete only the assigned task, use tools directly, and return a concise result.",
    allowedTools: Object.freeze([]),
    deniedTools: Object.freeze([]),
    scope: "builtin" as const,
  }),
  Object.freeze({
    name: "plan",
    description: "Read-only planning subagent for implementation plans and dependency analysis.",
    prompt: "You are a planning subagent. Inspect the codebase, identify constraints, and return an actionable implementation plan without modifying files.",
    allowedTools: Object.freeze([]),
    deniedTools: Object.freeze(["write_file", "apply_patch", "apply_diff", "run_command"]),
    permissionMode: "plan" as const,
    workMode: "plan" as const,
    scope: "builtin" as const,
  }),
  Object.freeze({
    name: "explore",
    description: "Read-only exploration subagent for locating code, behavior, and integration boundaries.",
    prompt: "You are an exploration subagent. Search and read the codebase efficiently, do not modify files, and report concrete findings with paths.",
    allowedTools: Object.freeze([]),
    deniedTools: Object.freeze(["write_file", "apply_patch", "apply_diff", "run_command"]),
    permissionMode: "plan" as const,
    workMode: "plan" as const,
    scope: "builtin" as const,
  }),
]);

export interface AgentDefinitionDirectories {
  readonly user: string;
  readonly project: string;
}

export class AgentDefinitionLoader {
  readonly directories: AgentDefinitionDirectories;
  private snapshot = new Map<string, AgentDefinition>();
  private initialized = false;

  constructor(readonly workspace: string, directories: Partial<AgentDefinitionDirectories> = {}) {
    this.workspace = resolve(workspace);
    this.directories = {
      user: directories.user ?? resolve(userDataRoot(), "agents"),
      project: directories.project ?? resolve(projectStateRoot(this.workspace), "agents"),
    };
  }

  async scan(): Promise<readonly AgentDefinition[]> {
    if (this.initialized) return this.list();
    const loaded = new Map<string, AgentDefinition>();
    for (const definition of BUILTIN_AGENT_DEFINITIONS) loaded.set(definition.name, definition);
    for (const [scope, directory] of [["user", this.directories.user], ["project", this.directories.project]] as const) {
      for (const filePath of await collectMarkdownFiles(directory)) {
        const definition = await loadAgentDefinition(filePath, scope);
        if (definition) loaded.set(definition.name, definition);
      }
    }
    this.snapshot = loaded;
    this.initialized = true;
    return this.list();
  }

  list(): readonly AgentDefinition[] {
    return Object.freeze([...this.snapshot.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }

  get(name: string): AgentDefinition | undefined {
    const normalized = normalizeAgentName(name);
    return normalized ? this.snapshot.get(normalized) : undefined;
  }
}

async function collectMarkdownFiles(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => resolve(directory, entry.name));
  } catch {
    return [];
  }
}

async function loadAgentDefinition(filePath: string, scope: AgentDefinitionScope): Promise<AgentDefinition | undefined> {
  try {
    return parseAgentDefinition(await readFile(filePath, "utf8"), scope, filePath);
  } catch {
    return undefined;
  }
}

function parseAgentDefinition(raw: string, scope: AgentDefinitionScope, filePath: string): AgentDefinition | undefined {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return undefined;
  const document = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
  if (document.errors.length) return undefined;
  const metadata = document.toJS() as unknown;
  if (!isRecord(metadata)) return undefined;
  const name = stringValue(metadata.name)?.toLowerCase();
  const description = stringValue(metadata.description);
  const prompt = lines.slice(closing + 1).join("\n").trim();
  if (!name || !AGENT_NAME.test(name) || !description || !prompt) return undefined;
  const allowedTools = stringArray(metadata.allowedTools ?? metadata["allowed-tools"]);
  const deniedTools = stringArray(metadata.deniedTools ?? metadata["denied-tools"]);
  if (!allowedTools || !deniedTools) return undefined;
  const model = optionalString(metadata.model);
  if (metadata.model !== undefined && !model) return undefined;
  const maxSteps = optionalPositiveInteger(metadata.maxSteps ?? metadata["max-steps"]);
  if ((metadata.maxSteps ?? metadata["max-steps"]) !== undefined && maxSteps === undefined) return undefined;
  const permissionModeValue = metadata.permissionMode ?? metadata["permission-mode"];
  if (permissionModeValue !== undefined && !isPermissionMode(permissionModeValue)) return undefined;
  const forceBackgroundValue = metadata.forceBackground ?? metadata["force-background"];
  if (forceBackgroundValue !== undefined && typeof forceBackgroundValue !== "boolean") return undefined;
  const isolationModeValue = metadata.isolation ?? metadata.isolationMode ?? metadata["isolation-mode"];
  if (isolationModeValue !== undefined && isolationModeValue !== "shared-workspace" && isolationModeValue !== "worktree") return undefined;
  const skills = optionalStringArray(metadata.skills);
  const mcpServers = optionalStringArray(metadata.mcpServers ?? metadata["mcp-servers"]);
  if (skills === null || mcpServers === null) return undefined;
  const memory = metadata.memory;
  if (memory !== undefined && typeof memory !== "boolean") return undefined;
  return Object.freeze({
    name,
    description,
    prompt,
    allowedTools: Object.freeze(allowedTools),
    deniedTools: Object.freeze(deniedTools),
    ...(model ? { model } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(permissionModeValue !== undefined ? { permissionMode: permissionModeValue } : {}),
    ...(permissionModeValue === "plan" ? { workMode: "plan" as const } : {}),
    ...(forceBackgroundValue !== undefined ? { forceBackground: forceBackgroundValue } : {}),
    ...(isolationModeValue !== undefined ? { isolationMode: isolationModeValue } : {}),
    ...(skills ? { skills: Object.freeze(skills) } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(mcpServers ? { mcpServers: Object.freeze(mcpServers) } : {}),
    scope,
    filePath,
  });
}

function normalizeAgentName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return AGENT_NAME.test(normalized) ? normalized : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : stringValue(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return undefined;
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  return stringArray(value) ?? null;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

