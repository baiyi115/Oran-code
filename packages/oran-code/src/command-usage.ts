import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "./paths.js";
import { isRecord } from "./types.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface CommandUsageEntry {
  readonly count: number;
  readonly lastUsedAt: string;
}

export interface RankedCommandUsage extends CommandUsageEntry {
  readonly name: string;
  readonly score: number;
}

export interface CommandUsageTrackerOptions {
  readonly path?: string;
  readonly halfLifeDays?: number;
  readonly minimumWeight?: number;
  readonly now?: () => number;
}

export class CommandUsageTracker {
  readonly path: string;
  private readonly halfLifeDays: number;
  private readonly minimumWeight: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CommandUsageEntry>();
  private persistence: Promise<void> | undefined;
  private dirty = false;

  private constructor(workspace: string, options: CommandUsageTrackerOptions) {
    this.path = options.path
      ? resolve(workspace, options.path)
      : resolve(projectStateRoot(workspace), "command-usage.json");
    this.halfLifeDays = positiveNumber(options.halfLifeDays, 14);
    this.minimumWeight = boundedNumber(options.minimumWeight, 0.05, 0, 1);
    this.now = options.now ?? Date.now;
  }

  static async load(
    workspace: string,
    options: CommandUsageTrackerOptions = {},
  ): Promise<CommandUsageTracker> {
    const tracker = new CommandUsageTracker(workspace, options);
    await tracker.loadFromDisk();
    return tracker;
  }

  record(commandName: string): void {
    const name = normalizeCommandName(commandName);
    if (!name) return;
    const current = this.entries.get(name);
    this.entries.set(name, {
      count: (current?.count ?? 0) + 1,
      lastUsedAt: new Date(this.now()).toISOString(),
    });
    this.queuePersistence();
  }

  score(commandName: string, at = this.now()): number {
    const entry = this.entries.get(normalizeCommandName(commandName));
    if (!entry) return 0;
    const ageDays = Math.max(0, at - Date.parse(entry.lastUsedAt)) / MILLISECONDS_PER_DAY;
    const decay = Math.exp(-Math.LN2 * ageDays / this.halfLifeDays);
    return entry.count * Math.max(this.minimumWeight, decay);
  }

  recent(limit: number, at = this.now()): RankedCommandUsage[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    return [...this.entries.entries()]
      .map(([name, entry]) => ({ ...entry, name, score: this.score(name, at) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score
        || Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt)
        || left.name.localeCompare(right.name))
      .slice(0, Math.floor(limit));
  }

  snapshot(): Readonly<Record<string, CommandUsageEntry>> {
    return Object.fromEntries(
      [...this.entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => [name, { ...entry }]),
    );
  }

  /** Allows an orderly shutdown to await queued writes; persistence errors remain silent. */
  async flush(): Promise<void> {
    await this.persistence;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isRecord(parsed)) return;
      for (const [rawName, rawEntry] of Object.entries(parsed)) {
        const name = normalizeCommandName(rawName);
        const entry = parseEntry(rawEntry);
        if (name && entry) this.entries.set(name, entry);
      }
    } catch {
      // Missing, unreadable, or malformed usage data starts with an empty tracker.
    }
  }

  private queuePersistence(): void {
    this.dirty = true;
    if (this.persistence) return;
    this.persistence = this.persistWhileDirty().finally(() => {
      this.persistence = undefined;
      if (this.dirty) this.queuePersistence();
    });
  }

  private async persistWhileDirty(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
      } catch {
        // Usage ranking is advisory; persistence must never interrupt command dispatch.
      }
    }
  }
}

function parseEntry(value: unknown): CommandUsageEntry | undefined {
  if (!isRecord(value) || typeof value.count !== "number" || !Number.isFinite(value.count) || value.count <= 0) {
    return undefined;
  }
  const lastUsedAt = typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined;
  if (!lastUsedAt || !Number.isFinite(Date.parse(lastUsedAt))) return undefined;
  return { count: Math.floor(value.count), lastUsedAt: new Date(lastUsedAt).toISOString() };
}

function normalizeCommandName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

