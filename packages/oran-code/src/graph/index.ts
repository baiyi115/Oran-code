import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { walkFiles, type WalkFailure } from "../tools/glob.js";
import { mapLimit } from "../utils/map-limit.js";
import { analyzeFile } from "./extract.js";
import { analyzeContribution } from "./contribution.js";
import { resolveCalls, resolveInherits, type PendingCall, type PendingInherit } from "./symbols.js";
import { loadConfigSnapshot } from "./resolve/config.js";
import { registerAllLanguages } from "./languages/all.js";
import {
  languageForFile,
  registeredLanguages,
  type GraphIndex,
  type LanguageSupport,
  type ResolveContext,
  type SymbolNode,
} from "./languages/registry.js";

function ensureLanguagesRegistered(): void {
  registerAllLanguages();
}

/**
 * Files analyzed concurrently. Per file the work alternates between this thread
 * (read, resolve, JSON) and the grammar's parse host, so a few requests in flight
 * hide each side behind the other instead of leaving both idle in turn. Requests
 * to one host are still served one at a time, so this is overlap, not parallelism
 * — enough to matter, small enough to keep memory flat.
 */
const ANALYZE_CONCURRENCY = Math.max(2, Math.min(6, availableParallelism() - 1));

/** Minimum spacing between build-progress notes; every note becomes a UI event. */
const PROGRESS_INTERVAL_MS = 250;

/** Called with a short human-readable note while a build runs. */
export type BuildProgress = (note: string) => void;

/**
 * Throttled progress over the files of one build. A cold build is the only
 * operation here that can run for a long time without saying anything, so the
 * count is reported to whoever can display it — but not once per file, since
 * each note crosses the event channel and triggers a render.
 */
function progressReporter(total: number, onProgress?: BuildProgress): () => void {
  if (!onProgress) return () => undefined;
  let done = 0;
  let reportedAt = 0;
  return () => {
    done += 1;
    const now = Date.now();
    if (done < total && now - reportedAt < PROGRESS_INTERVAL_MS) return;
    reportedAt = now;
    onProgress(`analyzing ${done}/${total} files`);
  };
}

export interface ScannedSource {
  path: string;
  mtimeMs: number;
}

/** Directory walk reusing the shared ignore rules; state directories excluded. */
export async function scanSources(root: string, onFailure?: (failure: WalkFailure) => void): Promise<ScannedSource[]> {
  const scanned: ScannedSource[] = [];
  ensureLanguagesRegistered();
  const extensions = new Set(registeredLanguages().flatMap((language) => language.extensions));
  await walkFiles(
    root,
    async (filePath, mtimeMs) => {
      const relative = filePath.slice(root.length).replaceAll("\\", "/").replace(/^\//, "");
      const dot = relative.lastIndexOf(".");
      if (dot < 0) return;
      if (!extensions.has(relative.slice(dot).toLowerCase())) return;
      // Declaration files are build artifacts, not sources.
      if (relative.endsWith(".d.ts")) return;
      scanned.push({ path: relative, mtimeMs });
    },
    onFailure,
  );
  scanned.sort((left, right) => left.path.localeCompare(right.path));
  return scanned;
}

/** Short fingerprint over path + mtime; no content reads. */
export function fingerprintSources(scanned: readonly ScannedSource[]): string {
  const material = scanned.map((file) => `${file.path}:${file.mtimeMs}`).join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Build-config files that steer resolution (go.mod module path, Cargo path
 * dependencies, composer psr-4, pubspec package name). They are not graph
 * nodes, but editing one re-resolves files that did not change at all, so
 * their mtimes have to take part in the freshness fingerprint.
 */
export const BUILD_CONFIG_FILES = ["go.mod", "Cargo.toml", "composer.json", "pubspec.yaml"] as const;

/** mtimes of the build-config files that exist; an absent file enters no material. */
export async function scanBuildConfigSources(root: string): Promise<ScannedSource[]> {
  const found: ScannedSource[] = [];
  for (const name of BUILD_CONFIG_FILES) {
    try {
      const info = await stat(join(root, name));
      found.push({ path: name, mtimeMs: info.mtimeMs });
    } catch {
      // Absent config file: nothing to fingerprint.
    }
  }
  return found;
}

/**
 * Read one source file, retrying once.
 *
 * A failed read used to be indistinguishable from an empty file: the caller got
 * "" and moved on, so the file quietly contributed no edges and `code_impact`
 * answered "nothing depends on it". Under load (many files in flight) that is
 * not hypothetical, so a transient EMFILE/EBUSY deserves one retry, and a
 * persistent failure is reported instead of swallowed.
 */
export async function readSourceText(path: string): Promise<{ text: string; failed: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { text: await readFile(path, "utf8"), failed: false };
    } catch {
      if (attempt >= 1) return { text: "", failed: true };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** package/namespace -> files declaring it; needed by java/kotlin/scala/c# resolution. */
async function buildPackageIndex(
  workspace: string,
  filesByLanguage: ReadonlyMap<LanguageSupport, ScannedSource[]>,
): Promise<Map<string, string[]>> {
  const packageIndex = new Map<string, string[]>();
  for (const [support, files] of filesByLanguage) {
    const packageQuery = support.packageQuery;
    if (!packageQuery) continue;
    for (const file of files) {
      const source = await readFile(`${workspace}/${file.path}`, "utf8").catch(() => "");
      if (!source) continue;
      const analysis = await analyzeFile(support, source, { pkg: packageQuery });
      for (const match of analysis.queries.pkg?.matches ?? []) {
        for (const capture of match.captures) {
          if (capture.name !== "pkg") continue;
          const pkg = capture.text
            .replace(/^(?:package|namespace)\s+/, "")
            .replace(/;\s*$/, "")
            .trim();
          if (!pkg) continue;
          const bucket = packageIndex.get(pkg);
          if (bucket) bucket.push(file.path);
          else packageIndex.set(pkg, [file.path]);
        }
      }
    }
  }
  return packageIndex;
}

export async function buildGraph(
  workspace: string,
  scanned: readonly ScannedSource[],
  onProgress?: BuildProgress,
): Promise<GraphIndex> {
  ensureLanguagesRegistered();
  const config = await loadConfigSnapshot(workspace);
  const fileSet = new Set(scanned.map((file) => file.path));
  // Rust crate root: the directory holding lib.rs or main.rs.
  if (fileSet.has("src/lib.rs") || fileSet.has("src/main.rs")) config.rustCrateRoot = "src";

  const index: GraphIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    languages: {},
    files: scanned.map((file) => file.path),
    imports: {},
    unresolved: {},
  };

  const filesByLanguage = new Map<LanguageSupport, ScannedSource[]>();
  for (const file of scanned) {
    const support = languageForFile(file.path);
    if (!support) continue;
    index.languages[file.path] = support.id;
    const bucket = filesByLanguage.get(support);
    if (bucket) bucket.push(file);
    else filesByLanguage.set(support, [file]);
  }

  const packageIndex = await buildPackageIndex(workspace, filesByLanguage);
  const resolveContext: ResolveContext = { fileSet, config, packageIndex };

  // One pass over every file: the analysis resolved here feeds both the import
  // edges and the symbol layer, so each file is parsed once. Deriving the symbol
  // data immediately — rather than keeping the matches until every definition is
  // known — is what makes one parse enough: call targets stay as unresolved
  // names until the global table exists. Sources are not cached either; the
  // single pass reads each file once and lets it go.
  const symbols: SymbolNode[] = [];
  const defsByNameByFile = new Map<string, Map<string, SymbolNode>>();
  const bindingsByFile = new Map<string, Map<string, string>>();
  const byName = new Map<string, SymbolNode[]>();
  const pendingCalls: PendingCall[] = [];
  const pendingInherits: PendingInherit[] = [];

  const tasks: Array<{ support: LanguageSupport; path: string }> = [];
  for (const [support, files] of filesByLanguage) {
    for (const file of files) tasks.push({ support, path: file.path });
  }

  const tick = progressReporter(tasks.length, onProgress);
  const contributions = await mapLimit(tasks, ANALYZE_CONCURRENCY, async ({ support, path }) => {
    const read = await readSourceText(`${workspace}/${path}`);
    tick();
    if (!read.text) return { path, imports: [], unresolved: [], symbols: undefined, incomplete: read.failed };
    const contribution = await analyzeContribution(support, path, read.text, resolveContext);
    return { ...contribution, path, incomplete: contribution.incomplete || read.failed };
  });

  // Merged in input order, so the index stays byte-identical for a given tree.
  const unparsed: string[] = [];
  for (const contribution of contributions) {
    if (contribution.incomplete) unparsed.push(contribution.path);
    if (contribution.imports.length > 0) index.imports[contribution.path] = contribution.imports;
    if (contribution.unresolved.length > 0) index.unresolved[contribution.path] = contribution.unresolved;
    const fileSymbols = contribution.symbols;
    if (!fileSymbols || fileSymbols.symbols.length === 0) continue;
    symbols.push(...fileSymbols.symbols);
    defsByNameByFile.set(contribution.path, fileSymbols.defsByName);
    if (fileSymbols.bindings.size > 0) bindingsByFile.set(contribution.path, fileSymbols.bindings);
    pendingCalls.push(...fileSymbols.calls);
    pendingInherits.push(...fileSymbols.inherits);
    for (const node of fileSymbols.symbols) {
      const bucket = byName.get(node.name);
      if (bucket) bucket.push(node);
      else byName.set(node.name, [node]);
    }
  }

  if (symbols.length > 0) {
    const scope = { defsByNameByFile, bindingsByFile, byName };
    index.symbols = symbols;
    index.calls = resolveCalls(pendingCalls, scope, new Set());
    index.extendsEdges = resolveInherits(pendingInherits, scope);
  }
  // A file whose analysis came back incomplete is still in `files`; say so, or
  // its missing edges read as "nothing imports it".
  if (unparsed.length > 0) index.unparsed = unparsed.sort();
  return index;
}
