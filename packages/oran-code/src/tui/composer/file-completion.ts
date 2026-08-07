import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceFileIndexOptions {
  readonly ignoredNames?: readonly string[];
  readonly maxEntries?: number;
}

export class WorkspaceFileIndex {
  private entries: string[] | undefined;
  private refreshPromise: Promise<readonly string[]> | undefined;
  private readonly ignoredNames: ReadonlySet<string>;
  private readonly maxEntries: number;

  constructor(private readonly workspace: string, options: WorkspaceFileIndexOptions = {}) {
    this.ignoredNames = new Set(options.ignoredNames ?? [".git", ".venv", "node_modules", "dist", "build", ".next", "coverage"]);
    this.maxEntries = Math.max(1, options.maxEntries ?? 10000);
  }

  invalidate(): void {
    this.entries = undefined;
  }

  async refresh(): Promise<readonly string[]> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.scan().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async search(query: string, limit = 200): Promise<string[]> {
    const entries = this.entries ?? await this.refresh();
    const normalized = query.toLowerCase();
    return entries.filter((entry) => !normalized || entry.toLowerCase().includes(normalized)).slice(0, Math.max(1, limit));
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
    return results;
  }
}
