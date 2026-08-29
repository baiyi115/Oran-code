import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { ModelProvider } from "./types.js";
import { isRecord } from "./types.js";
import { compatibleUserDataPath, projectHash, userMemoryRoot, USER_DATA_DIRECTORY } from "./paths.js";

// yaml 只服务于记忆笔记的 frontmatter;同步 API 无法 await 动态导入,
// 改为首次调用时经 require 同步加载,避免 46ms 的 yaml 进入交互启动关键模块图。
const requireYaml = createRequire(import.meta.url);
let yamlModule: typeof import("yaml") | undefined;
function yaml(): typeof import("yaml") {
  yamlModule ??= requireYaml("yaml") as typeof import("yaml");
  return yamlModule!;
}

export const MEMORY_NOTE_TYPES = [
  "user-preference",
  "correction-feedback",
  "project-knowledge",
  "reference-material",
] as const;
export type MemoryNoteType = (typeof MEMORY_NOTE_TYPES)[number];
export type MemoryScope = "project" | "user";

export interface MemoryNoteMetadata {
  readonly id: string;
  readonly type: MemoryNoteType;
  readonly description: string;
}
export interface MemoryNote extends MemoryNoteMetadata {
  readonly body: string;
  readonly path: string;
  readonly scope: MemoryScope;
  readonly modifiedAt: string;
}
export interface MemoryWriteInput extends MemoryNoteMetadata {
  readonly body: string;
  readonly fileName?: string;
}
export interface MemoryManagerOptions {
  readonly userDirectory?: string;
  readonly projectDirectory?: string;
  readonly maxIndexLines?: number;
  readonly maxIndexBytes?: number;
  readonly maxCandidates?: number;
  readonly maxRelevant?: number;
}
export interface FindRelevantOptions {
  readonly injectedIds?: Iterable<string>;
  readonly maxCandidates?: number;
  readonly maxResults?: number;
}

export const DEFAULT_MEMORY_INDEX_LINES = 200;
export const DEFAULT_MEMORY_INDEX_BYTES = 25 * 1024;
export const DEFAULT_MEMORY_CANDIDATES = 80;
export const DEFAULT_RELEVANT_MEMORIES = 5;
export const MEMORY_INDEX_FILE = "index.md";

const SUMMARY_PREFIX =
  "Long-term memory summaries are listed below.\nUse a file-reading tool to inspect a note only when its full body is needed.";
const SELECTOR_SYSTEM_PROMPT = [
  "Select only memories that are directly useful for the current request.",
  'Return strict JSON with exactly this shape: {"ids":["memory-id"]}.',
  'Use only IDs present in the candidate list. Return {"ids":[]} when none are relevant.',
].join("\n");

export class MemoryManager {
  readonly workspace: string;
  readonly projectDirectory: string;
  readonly userDirectory: string;
  readonly indexPath: string;
  private readonly maxIndexLines: number;
  private readonly maxIndexBytes: number;
  private readonly maxCandidates: number;
  private readonly maxRelevant: number;

  constructor(workspace: string, options: MemoryManagerOptions = {}) {
    this.workspace = resolve(workspace);
    this.projectDirectory = resolve(options.projectDirectory ?? userMemoryRoot(this.workspace));
    this.userDirectory = resolve(options.userDirectory ?? compatibleUserDataPath("memory"));
    this.indexPath = resolve(this.projectDirectory, MEMORY_INDEX_FILE);
    this.maxIndexLines = positiveInteger(options.maxIndexLines, DEFAULT_MEMORY_INDEX_LINES);
    this.maxIndexBytes = positiveInteger(options.maxIndexBytes, DEFAULT_MEMORY_INDEX_BYTES);
    this.maxCandidates = positiveInteger(options.maxCandidates, DEFAULT_MEMORY_CANDIDATES);
    this.maxRelevant = positiveInteger(options.maxRelevant, DEFAULT_RELEVANT_MEMORIES);
  }

  async scan(): Promise<MemoryNote[]> {
    const [project, user] = await Promise.all([
      this.scanDirectory(this.projectDirectory, "project"),
      this.scanDirectory(this.userDirectory, "user"),
    ]);
    return [...project, ...user];
  }

  async buildSummary(): Promise<string> {
    const notes = (await this.scan()).sort(compareById);
    if (!notes.length) return "";
    const lines = notes.map((note) => `- ${inline(note.id)} | ${note.type} | ${inline(note.description)}`);
    return boundLines([SUMMARY_PREFIX, ...lines], this.maxIndexLines, this.maxIndexBytes);
  }

  async rebuildIndex(): Promise<string> {
    const notes = (await this.scan()).sort(compareById);
    const lines = notes.map((note) => `- ${inline(note.id)} | ${this.displayPath(note)} | ${inline(note.description)}`);
    const content = boundLines(lines, this.maxIndexLines, this.maxIndexBytes);
    await mkdir(this.projectDirectory, { recursive: true });
    await atomicWrite(this.indexPath, content ? `${content}\n` : "");
    return content;
  }

  async writeNote(input: MemoryWriteInput): Promise<MemoryNote | undefined> {
    const normalized = normalizeWriteInput(input);
    if (!normalized) return undefined;
    const scope = scopeForType(normalized.type);
    const directory = scope === "project" ? this.projectDirectory : this.userDirectory;
    const existing = (await this.scan()).find((note) => note.scope === scope && note.id === normalized.id);
    const name = existing ? basename(existing.path) : safeMarkdownFileName(normalized.fileName ?? normalized.id);
    const path = resolveInside(directory, name);
    await mkdir(directory, { recursive: true });
    await atomicWrite(path, serializeMemoryNote(normalized));
    await this.rebuildIndex();
    const fileStat = await stat(path);
    return {
      id: normalized.id,
      type: normalized.type,
      description: normalized.description,
      body: normalized.body,
      path,
      scope,
      modifiedAt: fileStat.mtime.toISOString(),
    };
  }

  async findRelevant(query: string, provider: ModelProvider, options: FindRelevantOptions = {}): Promise<MemoryNote[]> {
    try {
      if (!query.trim()) return [];
      const injected = new Set(options.injectedIds ?? []);
      const maxCandidates = positiveInteger(options.maxCandidates, this.maxCandidates);
      const maxResults = positiveInteger(options.maxResults, this.maxRelevant);
      const candidates = (await this.scan())
        .filter((note) => !injected.has(note.id))
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
        .slice(0, maxCandidates);
      if (!candidates.length) return [];
      const response = await provider.complete([
        { role: "system", content: SELECTOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Query:\n${query.trim()}`,
            "Candidates:",
            ...candidates.map((note) =>
              [
                `- id: ${note.id}`,
                `  scope: ${note.scope}`,
                `  type: ${note.type}`,
                `  path: ${this.displayPath(note)}`,
                `  modified: ${note.modifiedAt}`,
                `  description: ${note.description}`,
              ].join("\n"),
            ),
          ].join("\n"),
        },
      ]);
      const selected = parseSelectedIds(response.text);
      const byId = new Map(candidates.map((note) => [note.id, note]));
      const result: MemoryNote[] = [];
      for (const id of selected) {
        const note = byId.get(id);
        if (note && !result.some((item) => item.id === id)) result.push(note);
        if (result.length >= maxResults) break;
      }
      return result;
    } catch {
      return [];
    }
  }

  private async scanDirectory(directory: string, scope: MemoryScope): Promise<MemoryNote[]> {
    const files = await listMarkdownFiles(directory);
    const notes = await Promise.all(
      files.map(async (path): Promise<MemoryNote | undefined> => {
        if (resolve(path) === this.indexPath) return undefined;
        try {
          const [content, fileStat] = await Promise.all([readFile(path, "utf8"), stat(path)]);
          const parsed = parseMemoryNote(content);
          return parsed ? { ...parsed, path, scope, modifiedAt: fileStat.mtime.toISOString() } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return notes.filter((note): note is MemoryNote => note !== undefined);
  }

  private displayPath(note: Pick<MemoryNote, "path" | "scope">): string {
    if (note.scope === "user")
      return `~/${USER_DATA_DIRECTORY}/memory/${toPortablePath(relative(this.userDirectory, note.path))}`;
    if (!relative(this.projectDirectory, note.path).startsWith("..")) {
      return `~/${USER_DATA_DIRECTORY}/memory/${projectHash(this.workspace)}/${toPortablePath(relative(this.projectDirectory, note.path))}`;
    }
    return toPortablePath(relative(this.workspace, note.path));
  }
}

export function isMemoryNoteType(value: unknown): value is MemoryNoteType {
  return typeof value === "string" && (MEMORY_NOTE_TYPES as readonly string[]).includes(value);
}

export function normalizeMemoryNoteType(value: unknown): MemoryNoteType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  const aliases: Record<string, MemoryNoteType> = {
    "user-preference": "user-preference",
    preference: "user-preference",
    用户偏好: "user-preference",
    "correction-feedback": "correction-feedback",
    correction: "correction-feedback",
    feedback: "correction-feedback",
    纠正反馈: "correction-feedback",
    "project-knowledge": "project-knowledge",
    project: "project-knowledge",
    项目知识: "project-knowledge",
    "reference-material": "reference-material",
    reference: "reference-material",
    参考资料: "reference-material",
  };
  return aliases[normalized];
}

export function parseMemoryNote(content: string): (MemoryNoteMetadata & { body: string }) | undefined {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u.exec(content);
  if (!match) return undefined;
  try {
    const frontmatter = yaml().parse(match[1] ?? "") as unknown;
    if (!isRecord(frontmatter)) return undefined;
    const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : undefined;
    const id =
      stringField(frontmatter.id) ??
      stringField(frontmatter.identifier) ??
      stringField(metadata?.id) ??
      stringField(metadata?.identifier);
    const description = stringField(frontmatter.description) ?? stringField(metadata?.description) ?? "";
    const type = normalizeMemoryNoteType(frontmatter.type ?? metadata?.type);
    const body = (match[2] ?? "").trim();
    return id && type && body ? { id, type, description, body } : undefined;
  } catch {
    return undefined;
  }
}

export function serializeMemoryNote(note: MemoryWriteInput): string {
  const frontmatter = yaml().stringify({ id: note.id, description: note.description, type: note.type }).trimEnd();
  return `---\n${frontmatter}\n---\n${note.body.trim()}\n`;
}

export function scopeForType(type: MemoryNoteType): MemoryScope {
  return type === "project-knowledge" || type === "reference-material" ? "project" : "user";
}

function normalizeWriteInput(input: MemoryWriteInput): MemoryWriteInput | undefined {
  const id = input.id.trim();
  const description = input.description.trim();
  const body = input.body.trim();
  if (!id || !isMemoryNoteType(input.type) || !body) return undefined;
  return { id, type: input.type, description, body, ...(input.fileName ? { fileName: input.fileName } : {}) };
}

function safeMarkdownFileName(value: string): string {
  const withoutExtension = basename(value.trim()).replace(/\.md$/iu, "");
  const safe = withoutExtension
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "-")
    .replace(/\.\.+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "")
    .slice(0, 96);
  return `${safe || `memory-${randomUUID().slice(0, 8)}`}.md`;
}

function resolveInside(directory: string, name: string): string {
  const root = resolve(directory);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("memory path escapes its directory");
  return target;
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry): Promise<string[]> => {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) return listMarkdownFiles(path);
          return entry.isFile() && entry.name.toLowerCase().endsWith(".md") ? [path] : [];
        }),
      )
    ).flat();
  } catch {
    return [];
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, path);
  } catch {
    await unlink(path).catch(() => undefined);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function boundLines(lines: readonly string[], maxLines: number, maxBytes: number): string {
  const accepted: string[] = [];
  let bytes = 0;
  for (const rawLine of lines)
    for (const line of rawLine.split(/\r?\n/u)) {
      if (accepted.length >= maxLines) return accepted.join("\n");
      const nextBytes = Buffer.byteLength(`${accepted.length ? "\n" : ""}${line}`, "utf8");
      if (bytes + nextBytes > maxBytes) return accepted.join("\n");
      accepted.push(line);
      bytes += nextBytes;
    }
  return accepted.join("\n");
}

function parseSelectedIds(value: string): string[] {
  const normalized = value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const objectStart = normalized.indexOf("{");
  const arrayStart = normalized.indexOf("[");
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(normalized.slice(start)) as unknown;
    const values = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.ids) ? parsed.ids : [];
    return values
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim());
  } catch {
    return [];
  }
}

function compareById(left: MemoryNote, right: MemoryNote): number {
  return left.id.localeCompare(right.id) || left.path.localeCompare(right.path);
}
function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function inline(value: string): string {
  return value
    .replace(/[\r\n|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
function toPortablePath(value: string): string {
  return value.split(sep).join("/");
}
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
