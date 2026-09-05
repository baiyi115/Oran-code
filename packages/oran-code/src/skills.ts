import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRegistry, type SlashCommand } from "./commands.js";
import { isRecord } from "./types.js";
import { LEGACY_USER_DATA_DIRECTORY, projectStateRoot } from "./paths.js";

export type SkillScope = "builtin" | "user" | "project";
export type SkillMode = "inline" | "derived";
export type SkillContextLevel = "none" | "recent" | "long";

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly mode: SkillMode;
  readonly context: SkillContextLevel;
  readonly model?: string;
  readonly body: string;
  readonly filePath: string;
  readonly rootDirectory: string;
  readonly scope: SkillScope;
  readonly mtimeMs: number;
}

export interface SkillDirectories {
  readonly builtin: string;
  readonly user: string;
  readonly project: string;
}

export type SkillDirectoryOverrides = Partial<SkillDirectories> & {
  /** Previous Oran code user directory. Set false to disable compatibility scanning. */
  readonly legacyUser?: string | false;
};

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SKILL_MODES = new Set<SkillMode>(["inline", "derived"]);
const CONTEXT_LEVELS = new Set<SkillContextLevel>(["none", "recent", "long"]);
const SKILL_SCOPES = new Set<SkillScope>(["builtin", "user", "project"]);
const SKILL_CACHE_VERSION = 1;
const MAX_SKILL_SOURCE_BYTES = 1_000_000;

interface PersistedSkillRecord {
  readonly skill: SkillDefinition;
  readonly size: number;
}

interface PersistedSkillCache {
  readonly version: number;
  readonly skills: readonly PersistedSkillRecord[];
}

/** Loads Markdown skills without allowing one malformed package to break discovery. */
export class SkillLoader {
  readonly workspace: string;
  readonly directories: SkillDirectories;
  private readonly legacyUserDirectory: string | undefined;
  private cache = new Map<string, SkillDefinition>();

  constructor(workspace: string, directories: SkillDirectoryOverrides = {}) {
    this.workspace = resolve(workspace);
    this.directories = {
      builtin: directories.builtin ?? resolveBuiltinSkillDirectory(),
      user: directories.user ?? resolve(homedir(), ".agents", "skills"),
      project: directories.project ?? resolve(projectStateRoot(this.workspace), "skills"),
    };
    this.legacyUserDirectory =
      directories.legacyUser === false
        ? undefined
        : (directories.legacyUser ??
          (directories.user === undefined ? resolve(homedir(), LEGACY_USER_DATA_DIRECTORY, "skills") : undefined));
  }

  async scan(): Promise<readonly SkillDefinition[]> {
    const previousByFile = new Map([...this.cache.values()].map((skill) => [skill.filePath, skill]));
    const persistedByFile = await this.loadPersistentCache();
    const next = new Map<string, SkillDefinition>();
    const layers: [SkillScope, string][] = [["builtin", this.directories.builtin]];
    if (this.legacyUserDirectory && this.legacyUserDirectory !== this.directories.user) {
      layers.push(["user", this.legacyUserDirectory]);
    }
    layers.push(["user", this.directories.user], ["project", this.directories.project]);

    const candidatesByLayer = await Promise.all(
      layers.map(async ([scope, directory]) => ({
        scope,
        candidates: await collectCandidates(directory),
      })),
    );
    const persisted: PersistedSkillRecord[] = [];
    for (const { scope, candidates } of candidatesByLayer) {
      const loadedCandidates = await Promise.all(
        candidates.map(async (candidate) => {
          const file = await statSkill(candidate.filePath);
          const cached = persistedByFile.get(candidate.filePath);
          if (
            file &&
            cached &&
            cached.skill.rootDirectory === candidate.rootDirectory &&
            cached.skill.scope === scope &&
            cached.skill.mtimeMs === file.mtimeMs &&
            cached.size === file.size
          ) {
            return { file, skill: cached.skill };
          }
          const skill =
            (await loadSkill(candidate.filePath, candidate.rootDirectory, scope, file)) ??
            previousByFile.get(candidate.filePath);
          return { file, skill };
        }),
      );
      for (const { file, skill } of loadedCandidates) {
        const loaded = skill;
        if (loaded) next.set(loaded.name, loaded);
        if (file && loaded && loaded.mtimeMs === file.mtimeMs) {
          persisted.push({ skill: loaded, size: file.size });
        }
      }
    }

    this.cache = next;
    void this.writePersistentCache(persisted);
    return this.list();
  }

  list(): readonly SkillDefinition[] {
    return [...this.cache.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    const normalized = normalizeSkillName(name);
    if (!normalized) return undefined;
    const cached = this.cache.get(normalized);
    if (!cached) return undefined;

    try {
      const file = await stat(cached.filePath);
      if (!file.isFile() || file.mtimeMs === cached.mtimeMs) return cached;
      const refreshed = await loadSkill(cached.filePath, cached.rootDirectory, cached.scope);
      if (!refreshed || refreshed.name !== cached.name) return cached;
      this.cache.set(cached.name, refreshed);
      return refreshed;
    } catch {
      return cached;
    }
  }

  async install(source: string, expectedName?: string): Promise<SkillDefinition> {
    const sourceLabel = source.trim();
    if (!sourceLabel) throw new Error("skill source must not be empty");
    const content = await readSkillSource(sourceLabel, this.workspace);
    const normalizedExpected = expectedName === undefined ? undefined : normalizeSkillName(expectedName);
    if (expectedName !== undefined && !normalizedExpected) throw new Error(`unsafe skill name: ${expectedName}`);
    const fallbackName = sourceNameFallback(sourceLabel);
    const parsed = await parseSkillContent(content, {
      ...(normalizedExpected ? { overrideName: normalizedExpected } : {}),
      ...(fallbackName ? { fallbackName } : {}),
    });
    if (!parsed) throw new Error(`invalid skill definition: ${sourceLabel}`);
    const installedContent = writeSkillName(content, parsed.name);

    const destinationDirectory = resolve(this.directories.project, parsed.name);
    const destination = resolve(destinationDirectory, "SKILL.md");
    if (dirname(destination) !== destinationDirectory) throw new Error(`unsafe skill name: ${parsed.name}`);
    if (existsSync(destination)) {
      throw new Error(`skill already exists: ${parsed.name}; remove it first or pass a different name`);
    }
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(destination, installedContent, "utf8");
    await this.scan();
    const installed = await this.get(parsed.name);
    if (!installed || installed.filePath !== destination) {
      throw new Error(`failed to install skill: ${sourceLabel}`);
    }
    return installed;
  }

  private persistentCachePath(): string {
    return resolve(projectStateRoot(this.workspace), "cache", "skills-v1.json");
  }

  private async loadPersistentCache(): Promise<Map<string, PersistedSkillRecord>> {
    try {
      const parsed = JSON.parse(await readFile(this.persistentCachePath(), "utf8")) as unknown;
      if (!isPersistedSkillCache(parsed)) return new Map();
      return new Map(parsed.skills.map((entry) => [entry.skill.filePath, entry]));
    } catch {
      return new Map();
    }
  }

  private async writePersistentCache(skills: readonly PersistedSkillRecord[]): Promise<void> {
    try {
      const path = this.persistentCachePath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: SKILL_CACHE_VERSION, skills }), "utf8");
    } catch {
      // Cache persistence must never prevent skill discovery.
    }
  }
}

export function renderSkillPrompt(skill: Pick<SkillDefinition, "body">, argument = ""): string {
  const rendered = skill.body.replaceAll("$ARGUMENTS", argument);
  if (!argument || skill.body.includes("$ARGUMENTS")) return rendered;
  return `${rendered.trimEnd()}\n\n## User request\n\n${argument}`;
}

export function assertSkillTools(
  skill: Pick<SkillDefinition, "name" | "allowedTools">,
  availableTools: Iterable<string>,
): void {
  if (skill.allowedTools.length === 0) return;
  const available = new Set(availableTools);
  const missing = skill.allowedTools.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`skill ${skill.name} requires unavailable tools: ${missing.join(", ")}`);
  }
}

export async function registerSkillCommands(
  registry: CommandRegistry,
  loaderOrOptions: SkillLoader | { readonly workspace: string },
): Promise<readonly SlashCommand[]> {
  const loader = loaderOrOptions instanceof SkillLoader ? loaderOrOptions : new SkillLoader(loaderOrOptions.workspace);
  await loader.scan();
  const registered: SlashCommand[] = [];
  for (const skill of loader.list()) {
    const command: SlashCommand = {
      name: `/${skill.name}`,
      aliases: [],
      description: `${skill.description} [skill]`,
      kind: skill.mode === "derived" ? "isolated-skill" : "prompt",
      handler: async (argument) => {
        const current = (await loader.get(skill.name)) ?? skill;
        return renderSkillPrompt(current, argument);
      },
    };
    if (!registry.canRegister(command)) continue;
    registry.register(command);
    registered.push(command);
  }
  return registered;
}

interface SkillCandidate {
  readonly filePath: string;
  readonly rootDirectory: string;
}

interface ParsedSkillContent {
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly mode: SkillMode;
  readonly context: SkillContextLevel;
  readonly model?: string;
  readonly body: string;
}

async function collectCandidates(directory: string): Promise<readonly SkillCandidate[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: SkillCandidate[] = [];
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      candidates.push({ filePath: resolve(path, "SKILL.md"), rootDirectory: path });
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      candidates.push({ filePath: path, rootDirectory: directory });
    }
  }
  return candidates;
}

async function loadSkill(
  filePath: string,
  rootDirectory: string,
  scope: SkillScope,
  knownFile?: Stats,
): Promise<SkillDefinition | undefined> {
  try {
    const file = knownFile ?? (await statSkill(filePath));
    if (!file) return undefined;
    const content = await readFile(filePath, "utf8");
    if (!file.isFile()) return undefined;
    const parsed = await parseSkillContent(content);
    if (!parsed) return undefined;
    return { ...parsed, filePath, rootDirectory, scope, mtimeMs: file.mtimeMs };
  } catch {
    return undefined;
  }
}

async function statSkill(filePath: string): Promise<Stats | undefined> {
  try {
    const file = await stat(filePath);
    return file.isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

function isPersistedSkillCache(value: unknown): value is PersistedSkillCache {
  return (
    isRecord(value) &&
    value.version === SKILL_CACHE_VERSION &&
    Array.isArray(value.skills) &&
    value.skills.every(isPersistedSkillRecord)
  );
}

function isPersistedSkillRecord(value: unknown): value is PersistedSkillRecord {
  return (
    isRecord(value) &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    isSkillDefinition(value.skill)
  );
}

function isSkillDefinition(value: unknown): value is SkillDefinition {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    SKILL_NAME.test(value.name) &&
    typeof value.description === "string" &&
    Array.isArray(value.allowedTools) &&
    value.allowedTools.every((tool) => typeof tool === "string") &&
    typeof value.mode === "string" &&
    SKILL_MODES.has(value.mode as SkillMode) &&
    typeof value.context === "string" &&
    CONTEXT_LEVELS.has(value.context as SkillContextLevel) &&
    (value.model === undefined || typeof value.model === "string") &&
    typeof value.body === "string" &&
    typeof value.filePath === "string" &&
    typeof value.rootDirectory === "string" &&
    typeof value.scope === "string" &&
    SKILL_SCOPES.has(value.scope as SkillScope) &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs)
  );
}

async function parseSkillContent(
  raw: string,
  names: { readonly overrideName?: string; readonly fallbackName?: string } = {},
): Promise<ParsedSkillContent | undefined> {
  const source = raw.replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return undefined;

  try {
    // yaml 仅在真正解析 SKILL.md 头部时加载,避免其进入交互启动的关键模块图。
    const { parseDocument } = await import("yaml");
    const document = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
    if (document.errors.length > 0) return undefined;
    const metadata = document.toJS() as unknown;
    if (!isRecord(metadata)) return undefined;

    const metadataName = metadata.name === undefined ? undefined : strictString(metadata.name)?.toLowerCase();
    if (metadata.name !== undefined && !metadataName) return undefined;
    const name = names.overrideName ?? metadataName ?? names.fallbackName;
    if (!name || !SKILL_NAME.test(name)) return undefined;
    const descriptionValue = metadata.description;
    if (descriptionValue !== undefined && typeof descriptionValue !== "string") return undefined;
    const description = strictString(descriptionValue) ?? "reusable skill";

    const toolsValue = metadata.allowedTools ?? metadata["allowed-tools"];
    if (
      toolsValue !== undefined &&
      (!Array.isArray(toolsValue) || toolsValue.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      return undefined;
    }
    const allowedTools =
      toolsValue === undefined ? [] : [...new Set((toolsValue as string[]).map((tool) => tool.trim()))];

    const modeValue = metadata.mode ?? "inline";
    if (typeof modeValue !== "string" || !SKILL_MODES.has(modeValue as SkillMode)) return undefined;
    const contextValue = metadata.context ?? metadata.contextLevel ?? metadata["context-level"] ?? "none";
    if (typeof contextValue !== "string" || !CONTEXT_LEVELS.has(contextValue as SkillContextLevel)) return undefined;
    const modelValue = metadata.model;
    if (modelValue !== undefined && (typeof modelValue !== "string" || !modelValue.trim())) return undefined;

    const body = lines
      .slice(closing + 1)
      .join("\n")
      .trim();
    if (!body) return undefined;
    return {
      name,
      description,
      allowedTools,
      mode: modeValue as SkillMode,
      context: contextValue as SkillContextLevel,
      ...(modelValue === undefined ? {} : { model: modelValue.trim() }),
      body,
    };
  } catch {
    return undefined;
  }
}

async function readSkillSource(source: string, workspace: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    if (source.toLowerCase().startsWith("http://")) {
      throw new Error(`refusing to fetch skill over insecure http: ${source}`);
    }
    let response: Response;
    try {
      // 无上限的响应体会把任意远端内容整个读进内存;redirect 手动跟随,
      // 防止 https 源经 302 降级到 http 绕过明文拒绝。
      response = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
      for (let redirects = 0; response.status >= 300 && response.status < 400; redirects += 1) {
        if (redirects >= 5) throw new Error("too many redirects");
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, source).toString();
        if (next.toLowerCase().startsWith("http://")) {
          throw new Error(`refusing to follow redirect to insecure http: ${next}`);
        }
        response = await fetch(next, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
      }
    } catch (error) {
      throw new Error(`failed to fetch skill ${source}: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok) throw new Error(`failed to fetch skill ${source}: HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SKILL_SOURCE_BYTES) {
      throw new Error(`skill source too large (>${MAX_SKILL_SOURCE_BYTES} bytes): ${source}`);
    }
    if (!response.body) throw new Error(`skill response has no body: ${source}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_SKILL_SOURCE_BYTES) throw new Error(`skill source too large (>${MAX_SKILL_SOURCE_BYTES} bytes): ${source}`);
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  }

  const localPath = isAbsolute(source) ? resolve(source) : resolve(workspace, source);
  try {
    const details = await stat(localPath);
    const filePath = details.isDirectory() ? resolve(localPath, "SKILL.md") : localPath;
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`failed to read skill ${source}: ${errorMessage(error)}`, { cause: error });
  }
}

function normalizeSkillName(name: string): string | undefined {
  const normalized = name.trim().replace(/^\/+/, "").toLowerCase();
  return SKILL_NAME.test(normalized) ? normalized : undefined;
}

function sourceNameFallback(source: string): string | undefined {
  try {
    const path = /^https?:\/\//i.test(source) ? new URL(source).pathname : source;
    const leaf = basename(path.replace(/[\\/]+$/, ""));
    const withoutExtension = extname(leaf) ? leaf.slice(0, -extname(leaf).length) : leaf;
    return normalizeSkillName(withoutExtension);
  } catch {
    return undefined;
  }
}

function writeSkillName(raw: string, name: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (lines[0] !== "---" || closing < 0) return raw;
  const existing = lines.findIndex((line, index) => index > 0 && index < closing && /^name\s*:/.test(line));
  if (existing >= 0) lines[existing] = `name: ${name}`;
  else lines.splice(1, 0, `name: ${name}`);
  return lines.join("\n");
}

function strictString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveBuiltinSkillDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}
