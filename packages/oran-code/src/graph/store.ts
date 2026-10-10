import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "../paths.js";
import {
  buildGraph,
  fingerprintSources,
  scanBuildConfigSources,
  scanSources,
  type BuildProgress,
  type ScannedSource,
} from "./index.js";
import { diffScans, touchesPackageLanguage, updateGraph } from "./incremental.js";
import type { GraphIndex } from "./languages/registry.js";

/**
 * Lazy build + freshness: every call re-scans paths + mtimes (cheap, no
 * content reads) and compares the fingerprint against the cached index.
 * No watcher, no staleness window. Modifications rebuild only the changed
 * files' edges on top of the previous index; additions/removals, build-config
 * edits, and package-index languages fall back to a full rebuild. The cache is
 * derived data under the gitignored state directory; a failed write never fails
 * the query, and a missing or corrupt cache file simply triggers a rebuild.
 */

/**
 * Bumped when the index a build produces changes for an unchanged tree: the
 * fingerprint above cannot see that, so an older index would keep being served.
 * 4: function-valued variables are symbols, and file-scope calls are attributed
 * to their module (before this, both were missing and now show up as new edges).
 */
const GRAPH_STATE_VERSION = 4;

interface PersistedGraph {
  version: typeof GRAPH_STATE_VERSION;
  fingerprint: string;
  /** Fingerprint over the build-config files; a change re-resolves everything. */
  configFingerprint: string;
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
  /**
   * Paths the directory walk could not read. They are missing from the index
   * entirely — unlike `index.unparsed`, which lists files that were seen but not
   * parsed — so anything that reports coverage has to mention them.
   */
  scanFailures: string[];
}

/** A loaded index; the per-call scan failures are attached by ensureGraph. */
type LoadedGraph = Omit<GraphHandle, "scanFailures">;

/**
 * In-flight builds, keyed by root + fingerprint. Read-only tools run with
 * concurrency (the executor defaults to 4), so a batch carrying two code_impact
 * calls would otherwise parse the whole repository twice and have both writers
 * race on the same cache file.
 */
const inflight = new Map<string, Promise<LoadedGraph>>();

export interface EnsureGraphOptions {
  rebuild?: boolean;
  /**
   * Progress notes for a build this call starts. A call that joins a build
   * already in flight reports nothing — there is nothing left for it to report.
   */
  onProgress?: BuildProgress | undefined;
}

export async function ensureGraph(root: string, options: EnsureGraphOptions = {}): Promise<GraphHandle> {
  const scanFailures: string[] = [];
  options.onProgress?.("scanning the workspace");
  const scanned: ScannedSource[] = await scanSources(root, (failure) => scanFailures.push(failure.path));
  const fingerprint = fingerprintSources(scanned);
  const configFingerprint = fingerprintSources(await scanBuildConfigSources(root));
  const key = `${root}\u0000${fingerprint}\u0000${configFingerprint}\u0000${options.rebuild === true ? "rebuild" : ""}`;
  const running = inflight.get(key);
  if (running) return { ...(await running), scanFailures };
  const run = loadOrBuild(root, scanned, fingerprint, configFingerprint, options).finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  inflight.set(key, run);
  return { ...(await run), scanFailures };
}

async function loadOrBuild(
  root: string,
  scanned: ScannedSource[],
  fingerprint: string,
  configFingerprint: string,
  options: EnsureGraphOptions,
): Promise<LoadedGraph> {
  const mtimes = Object.fromEntries(scanned.map((file) => [file.path, file.mtimeMs]));

  if (!options.rebuild) {
    const cached = await readPersisted(root);
    if (cached && cached.fingerprint === fingerprint && cached.configFingerprint === configFingerprint) {
      return { index: cached.index, fingerprint, cached: true, incremental: false };
    }
    if (cached && cached.configFingerprint === configFingerprint) {
      const change = diffScans(cached.mtimes ?? {}, scanned);
      const incrementalViable =
        change.added.size === 0 &&
        change.removed.size === 0 &&
        change.changed.size > 0 &&
        !touchesPackageLanguage(cached.index, change.changed);
      if (incrementalViable) {
        options.onProgress?.(`re-analyzing ${change.changed.size} changed file(s)`);
        const config = await import("./resolve/config.js").then((m) => m.loadConfigSnapshot(root));
        const fileSet = new Set(scanned.map((file) => file.path));
        if (fileSet.has("src/lib.rs") || fileSet.has("src/main.rs")) config.rustCrateRoot = "src";
        const index = await updateGraph(root, scanned, cached.index, change, {
          fileSet,
          config,
          packageIndex: new Map(),
        });
        await writePersisted(root, {
          version: GRAPH_STATE_VERSION,
          fingerprint,
          configFingerprint,
          mtimes,
          index,
        }).catch(() => undefined);
        return { index, fingerprint, cached: false, incremental: true };
      }
    }
  }

  const index = await buildGraph(root, scanned, options.onProgress);
  // Awaited so a back-to-back second call can actually hit the cache; a write
  // failure only costs the next call a rebuild.
  await writePersisted(root, { version: GRAPH_STATE_VERSION, fingerprint, configFingerprint, mtimes, index }).catch(
    () => undefined,
  );
  return { index, fingerprint, cached: false, incremental: false };
}

async function readPersisted(root: string): Promise<PersistedGraph | undefined> {
  try {
    const parsed = JSON.parse(await readFile(graphIndexPath(root), "utf8")) as Partial<PersistedGraph>;
    if (parsed.version !== GRAPH_STATE_VERSION || typeof parsed.fingerprint !== "string") return undefined;
    if (typeof parsed.configFingerprint !== "string") return undefined;
    if (!parsed.index || parsed.index.version !== 1) return undefined;
    return {
      version: GRAPH_STATE_VERSION,
      fingerprint: parsed.fingerprint,
      configFingerprint: parsed.configFingerprint,
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
  // Unique per write: two writers in the same process used to share one temp
  // name and could interleave into a half-written file.
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
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
