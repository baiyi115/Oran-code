import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceFileIndexOptions {
  readonly ignoredNames?: readonly string[];
  readonly maxEntries?: number;
  /** 索引过期时间(毫秒);过期后下一次 search 重新扫描,默认 15 秒。 */
  readonly staleAfterMs?: number;
}

export class WorkspaceFileIndex {
  private entries: string[] | undefined;
  private refreshPromise: Promise<readonly string[]> | undefined;
  private builtAt = 0;
  private readonly ignoredNames: ReadonlySet<string>;
  private readonly maxEntries: number;
  private readonly staleAfterMs: number;

  constructor(
    private readonly workspace: string,
    options: WorkspaceFileIndexOptions = {},
  ) {
    this.ignoredNames = new Set(
      options.ignoredNames ?? [".git", ".venv", "node_modules", "dist", "build", ".next", "coverage"],
    );
    this.maxEntries = Math.max(1, options.maxEntries ?? 10000);
    this.staleAfterMs = Math.max(1, options.staleAfterMs ?? 15_000);
  }

  invalidate(): void {
    this.entries = undefined;
    this.builtAt = 0;
  }

  async refresh(): Promise<readonly string[]> {
    const existing = this.refreshPromise;
    if (existing) return existing;
    const promise = this.scan().finally(() => {
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  /** 建好的索引在 TTL 内直接复用;过期前的下一次 search 重新扫描。 */
  async search(query: string, limit = 200): Promise<string[]> {
    const entries =
      this.entries && Date.now() - this.builtAt <= this.staleAfterMs ? this.entries : await this.refresh();
    const normalized = query.toLowerCase();
    return entries
      .filter((entry) => !normalized || entry.toLowerCase().includes(normalized))
      .slice(0, Math.max(1, limit));
  }

  private async scan(): Promise<string[]> {
    const results: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      if (results.length >= this.maxEntries) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (this.ignoredNames.has(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else results.push(absolute.slice(this.workspace.length + 1).replaceAll("\\", "/"));
        if (results.length >= this.maxEntries) return;
      }
    };
    await visit(this.workspace);
    this.entries = results;
    this.builtAt = Date.now();
    return results;
  }
}
