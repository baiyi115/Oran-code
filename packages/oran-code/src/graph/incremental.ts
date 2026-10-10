import { readSourceText, type ScannedSource } from "./index.js";
import { analyzeContribution, type FileContribution } from "./contribution.js";
import { resolveCalls, resolveInherits, type PendingCall, type PendingInherit } from "./symbols.js";
import { languageForFile, type GraphIndex, type ResolveContext, type SymbolNode } from "./languages/registry.js";

/**
 * Incremental rebuild: a file's out-edges (and its symbol data) depend only
 * on that file's content plus the resolution context, so modifications
 * re-extract just the changed files on top of the previous index — one parse
 * and one request per file, shared by the import edges and the symbol layer.
 * Additions and removals change the context itself (a new file can make another
 * file's import resolve) and fall back to a full rebuild in store.ts, as does
 * any change touching a package-index language (java/kotlin/scala/c#), whose
 * package table is not worth re-deriving incrementally. Call edges from
 * unchanged files are kept only while their target symbol still exists.
 */

export interface IncrementalChange {
  /** Files that were not in the previous scan; they change the resolution context. */
  added: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  removed: ReadonlySet<string>;
}

/** Languages whose package table forces a full rebuild when touched. */
export function touchesPackageLanguage(index: GraphIndex, changed: ReadonlySet<string>): boolean {
  for (const path of changed) {
    const languageId = index.languages[path];
    if (!languageId) continue;
    const support = languageForFile(path);
    if (support?.packageQuery && support.id === languageId) return true;
  }
  return false;
}

/**
 * Diff the previous per-file mtimes against the fresh scan. A file the previous
 * scan never saw is an *addition*, not a modification: it can make another
 * file's previously unresolvable import resolve, so it must not be handled by
 * the incremental path.
 */
export function diffScans(
  previous: Readonly<Record<string, number>>,
  scanned: readonly ScannedSource[],
): IncrementalChange {
  const added = new Set<string>();
  const changed = new Set<string>();
  const removed = new Set<string>(Object.keys(previous));
  for (const file of scanned) {
    const known = previous[file.path];
    if (known === undefined) added.add(file.path);
    else if (known !== file.mtimeMs) changed.add(file.path);
    removed.delete(file.path);
  }
  return { added, changed, removed };
}

export async function updateGraph(
  workspace: string,
  scanned: readonly ScannedSource[],
  previous: GraphIndex,
  change: IncrementalChange,
  resolveContext: ResolveContext,
): Promise<GraphIndex> {
  const index: GraphIndex = structuredClone(previous);
  index.builtAt = new Date().toISOString();

  for (const path of change.removed) {
    delete index.languages[path];
    delete index.imports[path];
    delete index.unresolved[path];
    index.files = index.files.filter((file) => file !== path);
  }
  index.files = [...new Set([...index.files, ...scanned.map((file) => file.path)])].sort();

  const fileOf = (symbolId: string): string => symbolId.split("#")[0] ?? "";
  const reextracted = new Set<string>([...change.changed, ...change.added]);
  const touched = (file: string): boolean => change.removed.has(file) || reextracted.has(file);
  const survivingSymbols = (index.symbols ?? []).filter((symbol) => !touched(symbol.file));
  // Edges whose *caller* file was re-extracted are rebuilt below; edges whose
  // caller did not change are kept only while their target still exists (see
  // symbolIds).
  const survivingCalls = (index.calls ?? []).filter((edge) => !touched(fileOf(edge.from)));
  const survivingExtends = (index.extendsEdges ?? []).filter((edge) => !touched(fileOf(edge.from)));

  const freshSymbols: SymbolNode[] = [];
  const defsByNameByFile = new Map<string, Map<string, SymbolNode>>();
  const bindingsByFile = new Map<string, Map<string, string>>();
  const pendingCalls: PendingCall[] = [];
  const pendingInherits: PendingInherit[] = [];

  // Files that could not be parsed stay in the index, so the set has to survive
  // the rebuild: entries for re-extracted files are replaced by this run's result.
  const unparsed = new Set((previous.unparsed ?? []).filter((path) => !touched(path)));

  for (const path of reextracted) {
    const support = languageForFile(path);
    if (!support || index.languages[path] !== support.id) continue;
    const read = await readSourceText(`${workspace}/${path}`);
    let contribution: FileContribution = { imports: [], unresolved: [], incomplete: read.failed };
    if (read.text) {
      const analyzed = await analyzeContribution(support, path, read.text, resolveContext);
      contribution = { ...analyzed, incomplete: analyzed.incomplete || read.failed };
    }
    const { symbols: fileSymbols } = contribution;
    if (fileSymbols && fileSymbols.symbols.length > 0) {
      freshSymbols.push(...fileSymbols.symbols);
      defsByNameByFile.set(path, fileSymbols.defsByName);
      if (fileSymbols.bindings.size > 0) bindingsByFile.set(path, fileSymbols.bindings);
      pendingCalls.push(...fileSymbols.calls);
      pendingInherits.push(...fileSymbols.inherits);
    }
    if (contribution.incomplete) unparsed.add(path);
    if (contribution.imports.length > 0) index.imports[path] = contribution.imports;
    else delete index.imports[path];
    if (contribution.unresolved.length > 0) index.unresolved[path] = contribution.unresolved;
    else delete index.unresolved[path];
  }

  const symbols = [...survivingSymbols, ...freshSymbols];
  const byName = new Map<string, SymbolNode[]>();
  for (const node of symbols) {
    const bucket = byName.get(node.name);
    if (bucket) bucket.push(node);
    else byName.set(node.name, [node]);
  }
  const scope = { defsByNameByFile, bindingsByFile, byName };
  const freshCallEdges = resolveCalls(pendingCalls, scope, new Set());
  const freshExtends = resolveInherits(pendingInherits, scope);

  // A caller that did not change still contains the same call sites, so its edge
  // stays valid as long as the target symbol is still there. A rename or a
  // deletion in the callee's file leaves a dangling id, and `callers` mode would
  // then report a call site for a symbol that no longer exists.
  const symbolIds = new Set(symbols.map((node) => node.id));
  const keptCalls = survivingCalls.filter((edge) => !touched(fileOf(edge.to)) || symbolIds.has(edge.to));
  const keptExtends = survivingExtends.filter((edge) => !touched(fileOf(edge.to)) || symbolIds.has(edge.to));
  const newCalls = [...keptCalls, ...freshCallEdges];
  const newExtends = [...keptExtends, ...freshExtends];

  if (symbols.length > 0) index.symbols = symbols;
  else delete index.symbols;
  if (newCalls.length > 0) index.calls = newCalls;
  else delete index.calls;
  if (newExtends.length > 0) index.extendsEdges = newExtends;
  else delete index.extendsEdges;
  if (unparsed.size > 0) index.unparsed = [...unparsed].sort();
  else delete index.unparsed;

  return index;
}
