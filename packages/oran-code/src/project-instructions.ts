import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { LEGACY_PROJECT_STATE_DIRECTORY, LEGACY_USER_DATA_DIRECTORY, PROJECT_STATE_DIRECTORY, USER_DATA_DIRECTORY } from "./paths.js";

export const DEFAULT_MAX_INSTRUCTION_INCLUDE_DEPTH = 5;

export interface ProjectInstructionLayout {
  readonly user: readonly string[];
  readonly hierarchy: readonly string[];
  readonly legacy: readonly string[];
  readonly local: readonly string[];
}

export interface LoadProjectInstructionsOptions {
  readonly workspace: string;
  readonly repositoryRoot?: string;
  readonly userHome?: string;
  readonly maxIncludeDepth?: number;
  readonly layout?: Partial<ProjectInstructionLayout>;
}

const DEFAULT_LAYOUT: ProjectInstructionLayout = {
  user: ["ORAN.md", "AGENTS.md"],
  hierarchy: ["ORAN.md", "AGENTS.md", "LITEAGENT.md"],
  legacy: [
    `${PROJECT_STATE_DIRECTORY}/INSTRUCTIONS.md`, `${PROJECT_STATE_DIRECTORY}/AGENTS.md`,
    `${LEGACY_PROJECT_STATE_DIRECTORY}/INSTRUCTIONS.md`, `${LEGACY_PROJECT_STATE_DIRECTORY}/AGENTS.md`, `${LEGACY_PROJECT_STATE_DIRECTORY}/CLAUDE.md`,
  ],
  local: [
    `${PROJECT_STATE_DIRECTORY}/INSTRUCTIONS.local.md`, `${PROJECT_STATE_DIRECTORY}/ORAN.local.md`, `${PROJECT_STATE_DIRECTORY}/AGENTS.local.md`,
    `${LEGACY_PROJECT_STATE_DIRECTORY}/INSTRUCTIONS.local.md`, `${LEGACY_PROJECT_STATE_DIRECTORY}/LITEAGENT.local.md`, `${LEGACY_PROJECT_STATE_DIRECTORY}/AGENTS.local.md`,
  ],
};

interface ExpandContext {
  readonly workspace: string;
  readonly userHome: string;
  readonly maxDepth: number;
  readonly visited: Set<string>;
}

/** Loads instructions from low to high priority. Later sections take precedence. */
export async function loadProjectInstructions(options: LoadProjectInstructionsOptions): Promise<string> {
  const workspace = resolve(options.workspace);
  const userHome = resolve(options.userHome ?? homedir());
  const repositoryRoot = options.repositoryRoot ? resolve(options.repositoryRoot) : await findRepositoryRoot(workspace);
  const layout = resolveLayout(options.layout);
  const sources = instructionSources(workspace, repositoryRoot, userHome, layout);
  const context: ExpandContext = {
    workspace,
    userHome,
    maxDepth: normalizeDepth(options.maxIncludeDepth),
    visited: new Set<string>(),
  };
  const sections: string[] = [];

  for (const source of sources) {
    const content = await readText(source);
    if (content === undefined) continue;
    context.visited.add(pathKey(source));
    const expanded = await expandIncludes(content, source, 0, context);
    sections.push(`<!-- instructions-source: ${source} -->\n${expanded.trim()}`.trimEnd());
  }
  return sections.join("\n\n---\n\n");
}

function resolveLayout(overrides: Partial<ProjectInstructionLayout> | undefined): ProjectInstructionLayout {
  return {
    user: overrides?.user ?? DEFAULT_LAYOUT.user,
    hierarchy: overrides?.hierarchy ?? DEFAULT_LAYOUT.hierarchy,
    legacy: overrides?.legacy ?? DEFAULT_LAYOUT.legacy,
    local: overrides?.local ?? DEFAULT_LAYOUT.local,
  };
}

function instructionSources(
  workspace: string,
  repositoryRoot: string,
  userHome: string,
  layout: ProjectInstructionLayout,
): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    const absolute = resolve(path);
    const key = pathKey(absolute);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(absolute);
  };
  for (const name of layout.user) add(resolve(userHome, USER_DATA_DIRECTORY, name));
  for (const name of ["LITEAGENT.md", "AGENTS.md"]) add(resolve(userHome, LEGACY_USER_DATA_DIRECTORY, name));
  for (const directory of hierarchyDirectories(repositoryRoot, workspace)) {
    for (const name of layout.hierarchy) add(resolve(directory, name));
  }
  for (const name of layout.legacy) add(resolve(workspace, name));
  for (const name of layout.local) add(resolve(workspace, name));
  return sources;
}

function hierarchyDirectories(repositoryRoot: string, workspace: string): string[] {
  if (!isWithin(repositoryRoot, workspace)) return [workspace];
  const directories = [repositoryRoot];
  const suffix = relative(repositoryRoot, workspace);
  if (!suffix) return directories;
  let current = repositoryRoot;
  for (const segment of suffix.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, segment);
    directories.push(current);
  }
  return directories;
}

async function expandIncludes(content: string, source: string, depth: number, context: ExpandContext): Promise<string> {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let fence: "```" | "~~~" | undefined;
  for (const line of lines) {
    const marker = markdownFenceMarker(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      output.push(line);
      continue;
    }
    if (fence || !line.startsWith("@")) {
      output.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      output.push(line.slice(1));
      continue;
    }
    const reference = line.slice(1);
    if (!reference || /\s/.test(reference)) {
      output.push(line);
      continue;
    }
    if (depth >= context.maxDepth) {
      output.push(line);
      continue;
    }
    const target = resolveInclude(reference, source, context);
    if (!target) continue;
    const key = pathKey(target);
    if (context.visited.has(key)) {
      output.push(line);
      continue;
    }
    const included = await readText(target);
    if (included === undefined) continue;
    context.visited.add(key);
    output.push(`<!-- include-source: ${target} -->`);
    output.push(await expandIncludes(included, target, depth + 1, context));
  }
  return output.join("\n");
}

function resolveInclude(reference: string, source: string, context: ExpandContext): string | undefined {
  if (reference === "~") return undefined;
  if (reference.startsWith("~/") || reference.startsWith("~\\")) return resolve(context.userHome, reference.slice(2));
  if (isAbsolute(reference)) return resolve(reference);
  const target = resolve(dirname(source), reference);
  return isWithin(context.workspace, target) ? target : undefined;
}

function markdownFenceMarker(line: string): "```" | "~~~" | undefined {
  const marker = /^\s*(```|~~~)/.exec(line)?.[1];
  return marker === "```" || marker === "~~~" ? marker : undefined;
}

function normalizeDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_INSTRUCTION_INCLUDE_DEPTH;
  return Math.max(0, Math.floor(value));
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

async function findRepositoryRoot(workspace: string): Promise<string> {
  let current = workspace;
  while (true) {
    if (await exists(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return workspace;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
