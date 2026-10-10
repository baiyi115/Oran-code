import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "../paths.js";
import { buildGraph, fingerprintSources, scanSources, type ScannedSource } from "./index.js";
import { diffScans, touchesPackageLanguage, updateGraph } from "./incremental.js";
import type { GraphIndex } from "./languages/registry.js";

/**
 * Lazy build + freshness: every call re-scans paths + mtimes (cheap, no
 * content reads) and compares the fingerprint against the cached index.
 * No watcher, no staleness window. Modifications rebuild only the changed
 * files' edges on top of the previous index; additions/removals and
 * package-index languages fall back to a full rebuild. The cache is derived
 * data under the gitignored state directory; a failed write never fails the
 * query, and a missing or corrupt cache file simply triggers a rebuild.
 */

const GRAPH_STATE_VERSION = 2;

interface PersistedGraph {
  version: typeof GRAPH_STATE_VERSION;
  fingerprint: string;
  /** Per-file mtime at build time, for incremental diffing. */
  mtimes: Record<string, number>;
  index: GraphIndex;
}

export interface GraphHandle {
  index: GraphIndex;
  fingerprint: string;
  cached: boolean;
  /** True when only changed files were re-extracted on top of the previous index. */
  incremental: boolean;
}

export async function ensureGraph(root: string, options: { rebuild?: boolean } = {}): Promise<GraphHandle> {
  const scanned: ScannedSource[] = await scanSources(root);
  const fingerprint = fingerprintSources(scanned);
  const mtimes = Object.fromEntries(scanned.map((file) => [file.path, file.mtimeMs]));

  if (!options.rebuild) {
    const cached = await readPersisted(root);
    if (cached && cached.fingerprint === fingerprint) {
      return { index: cached.index, fingerprint, cached: true, incremental: false };
    }
    if (cached) {
      const change = diffScans(cached.mtimes ?? {}, scanned);
      const incrementalViable =
        change.removed.size === 0 && change.changed.size > 0 && !touchesPackageLanguage(cached.index, change.changed);
      if (incrementalViable) {
        const config = await import("./resolve/config.js").then((m) => m.loadConfigSnapshot(root));
        const fileSet = new Set(scanned.map((file) => file.path));
        if (fileSet.has("src/lib.rs") || fileSet.has("src/main.rs")) config.rustCrateRoot = "src";
        const index = await updateGraph(root, scanned, cached.index, change, {
          fileSet,
          config,
          packageIndex: new Map(),
        });
        await writePersisted(root, { version: GRAPH_STATE_VERSION, fingerprint, mtimes, index }).catch(() => undefined);
        return { index, fingerprint, cached: false, incremental: true };
      }
    }
  }

  const index = await buildGraph(root, scanned);
  // Awaited so a back-to-back second call can actually hit the cache; a write
  // failure only costs the next call a rebuild.
  await writePersisted(root, { version: GRAPH_STATE_VERSION, fingerprint, mtimes, index }).catch(() => undefined);
  return { index, fingerprint, cached: false, incremental: false };
}

async function readPersisted(root: string): Promise<PersistedGraph | undefined> {
  try {
    const parsed = JSON.parse(await readFile(graphIndexPath(root), "utf8")) as Partial<PersistedGraph>;
    if (parsed.version !== GRAPH_STATE_VERSION || typeof parsed.fingerprint !== "string") return undefined;
    if (!parsed.index || parsed.index.version !== 1) return undefined;
    return {
      version: GRAPH_STATE_VERSION,
      fingerprint: parsed.fingerprint,
      mtimes: parsed.mtimes && typeof parsed.mtimes === "object" ? parsed.mtimes : {},
      index: parsed.index,
    };
  } catch {
    return undefined;
  }
}

async function writePersisted(root: string, graph: PersistedGraph): Promise<void> {
  const path = graphIndexPath(root);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(graph)}\n`, "utf8");
  await rename(temporary, path);
}

export function graphIndexPath(root: string): string {
  return resolve(projectStateRoot(root), "graph", "index.json");
}

/** Read the cached index without ever building (used by progress novelty). */
export async function readCachedGraph(root: string): Promise<GraphIndex | undefined> {
  const cached = await readPersisted(root);
  return cached?.index;
}
