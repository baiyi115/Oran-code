import { readFile } from "node:fs/promises";
import { extractSpecifiers, runQuery, stripQuotes } from "./extract.js";
import type { QueryMatchData } from "./extract-raw.js";
import {
  languageForFile,
  type CallEdge,
  type GraphIndex,
  type InheritanceEdge,
  type LanguageSupport,
  type ResolveContext,
  type SymbolNode,
  type UnresolvedImport,
} from "./languages/registry.js";
import type { ScannedSource } from "./index.js";

/**
 * Incremental rebuild: a file's out-edges (and its symbol data) depend only
 * on that file's content plus the resolution context, so modifications
 * re-extract just the changed files on top of the previous index. Additions
 * and removals change the context itself and fall back to a full rebuild, as
 * does any change touching a package-index language (java/kotlin/scala/c#),
 * whose package table is not worth re-deriving incrementally.
 */

interface DefSpan {
  node: SymbolNode;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

interface FileSymbolData {
  symbols: SymbolNode[];
  calls: CallEdge[];
  extendsEdges: InheritanceEdge[];
}

async function safeQuery(grammar: string, query: string, source: string): Promise<QueryMatchData[]> {
  try {
    return await runQuery(grammar, query, source);
  } catch {
    return [];
  }
}

async function safeSpecifiers(support: LanguageSupport, source: string): Promise<string[]> {
  try {
    return await extractSpecifiers(support, source);
  } catch {
    return [];
  }
}

function innermostOwner(spans: DefSpan[], row: number, column: number): DefSpan | undefined {
  let best: DefSpan | undefined;
  for (const span of spans) {
    const afterStart = span.startRow < row || (span.startRow === row && span.startColumn <= column);
    const beforeEnd = span.endRow > row || (span.endRow === row && span.endColumn >= column);
    if (!afterStart || !beforeEnd) continue;
    if (!best || span.startRow > best.startRow || (span.startRow === best.startRow && span.startColumn > best.startColumn)) {
      best = span;
    }
  }
  return best;
}

async function symbolDataForFile(
  support: LanguageSupport,
  file: string,
  spans: DefSpan[],
  source: string,
  resolveContext: ResolveContext,
  byName: ReadonlyMap<string, SymbolNode[]>,
): Promise<FileSymbolData> {
  const calls: CallEdge[] = [];
  const extendsEdges: InheritanceEdge[] = [];
  const seen = new Set<string>();

  const resolveTarget = (name: string, bindings: Map<string, string>): SymbolNode | undefined => {
    const sameFile = spans.find((span) => span.node.name === name)?.node;
    if (sameFile) return sameFile;
    const importedFile = bindings.get(name);
    if (importedFile !== undefined) {
      const candidates = (byName.get(name) ?? []).filter((node) => node.file === importedFile);
      if (candidates.length === 1) return candidates[0];
    }
    return undefined;
  };

  return (async () => {
    const bindings = new Map<string, string>();
    for (const match of await safeQuery(support.grammar, support.symbols!.bindings, source)) {
      const bind = match.captures.find((capture) => capture.name === "bind");
      const src = match.captures.find((capture) => capture.name === "src");
      if (!bind || !src) continue;
      const result = support.resolve(file, stripQuotes(src.text), resolveContext);
      if (result.kind === "resolved" && result.paths[0] !== undefined) bindings.set(bind.text, result.paths[0]);
    }

    for (const match of await safeQuery(support.grammar, support.symbols!.calls, source)) {
      const callee = match.captures.find((capture) => capture.name === "callee");
      if (!callee) continue;
      const owner = innermostOwner(spans, callee.row, callee.column);
      if (!owner) continue;
      const target = resolveTarget(callee.text, bindings);
      if (!target) continue;
      const from = owner.node.id;
      const key = `${from}->${target.id}`;
      if (from === target.id || seen.has(key)) continue;
      seen.add(key);
      calls.push({ from, to: target.id, provenance: "resolved" });
    }

    for (const match of await safeQuery(support.grammar, support.symbols!.inherit, source)) {
      const klass = match.captures.find((capture) => capture.name === "class");
      const superName = match.captures.find((capture) => capture.name === "super");
      if (!klass || !superName) continue;
      const target = resolveTarget(superName.text, bindings);
      if (!target) continue;
      extendsEdges.push({ from: `${file}#${klass.text}`, to: target.id });
    }
    return { symbols: spans.map((span) => span.node), calls, extendsEdges };
  })();
}

export interface IncrementalChange {
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

/** Diff the previous per-file mtimes against the fresh scan. */
export function diffScans(previous: Readonly<Record<string, number>>, scanned: readonly ScannedSource[]): IncrementalChange {
  const changed = new Set<string>();
  const removed = new Set<string>(Object.keys(previous));
  for (const file of scanned) {
    if (previous[file.path] === file.mtimeMs) {
      removed.delete(file.path);
      continue;
    }
    changed.add(file.path);
    removed.delete(file.path);
  }
  return { changed, removed };
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
  const survivingSymbols = (index.symbols ?? []).filter(
    (symbol) => !change.removed.has(symbol.file) && !change.changed.has(symbol.file),
  );
  const survivingCalls = (index.calls ?? []).filter(
    (edge) => !change.removed.has(fileOf(edge.from)) && !change.changed.has(fileOf(edge.from)),
  );
  const survivingExtends = (index.extendsEdges ?? []).filter(
    (edge) => !change.removed.has(fileOf(edge.from)) && !change.changed.has(fileOf(edge.from)),
  );

  const freshSymbols: SymbolNode[] = [];
  const freshByFile = new Map<string, DefSpan[]>();
  const freshData = new Map<string, { support: LanguageSupport; source: string }>();

  for (const path of change.changed) {
    const support = languageForFile(path);
    if (!support || !support.symbols || index.languages[path] !== support.id) continue;
    const source = await readFile(`${workspace}/${path}`, "utf8").catch(() => "");
    if (!source) continue;
    freshData.set(path, { support, source });
    const spans: DefSpan[] = [];
    for (const match of await safeQuery(support.grammar, support.symbols.defs, source)) {
      const nameCapture = match.captures.find((capture) => capture.name === "name");
      const defCapture = match.captures.find((capture) => capture.name === "def");
      const kind = support.symbols.defKinds[match.pattern];
      if (!nameCapture || !defCapture || !kind) continue;
      const node: SymbolNode = {
        id: `${path}#${nameCapture.text}`,
        file: path,
        kind: kind as SymbolNode["kind"],
        name: nameCapture.text,
        line: nameCapture.row + 1,
      };
      if (spans.some((existing) => existing.node.id === node.id)) continue;
      spans.push({
        node,
        startRow: defCapture.row,
        startColumn: defCapture.column,
        endRow: defCapture.endRow,
        endColumn: defCapture.endColumn,
      });
      freshSymbols.push(node);
    }
    freshByFile.set(path, spans);
  }

  const byName = new Map<string, SymbolNode[]>();
  for (const node of [...survivingSymbols, ...freshSymbols]) {
    const bucket = byName.get(node.name);
    if (bucket) bucket.push(node);
    else byName.set(node.name, [node]);
  }

  const newCalls: CallEdge[] = [...survivingCalls];
  const newExtends: InheritanceEdge[] = [...survivingExtends];
  for (const [path, { support, source }] of freshData) {
    const spans = freshByFile.get(path)!;
    const fileData = await symbolDataForFile(support, path, spans, source, resolveContext, byName);
    newCalls.push(...fileData.calls);
    newExtends.push(...fileData.extendsEdges);
  }

  if (survivingSymbols.length + freshSymbols.length > 0) index.symbols = [...survivingSymbols, ...freshSymbols];
  else delete index.symbols;
  if (newCalls.length > 0) index.calls = newCalls;
  else delete index.calls;
  if (newExtends.length > 0) index.extendsEdges = newExtends;
  else delete index.extendsEdges;

  // Refresh L1 edges for changed files.
  for (const path of change.changed) {
    const support = languageForFile(path);
    if (!support) continue;
    const source = await readFile(`${workspace}/${path}`, "utf8").catch(() => "");
    const direct: string[] = [];
    const unresolved: UnresolvedImport[] = [];
    if (source) {
      for (const specifier of await safeSpecifiers(support, source)) {
        const result = support.resolve(path, specifier, resolveContext);
        if (result.kind === "resolved") {
          for (const target of result.paths) {
            if (target !== path && !direct.includes(target)) direct.push(target);
          }
        } else if (!unresolved.some((item) => item.specifier === specifier && item.reason === result.reason)) {
          unresolved.push({ specifier, reason: result.reason });
        }
      }
    }
    if (direct.length > 0) index.imports[path] = direct.sort();
    else delete index.imports[path];
    if (unresolved.length > 0) index.unresolved[path] = unresolved;
    else delete index.unresolved[path];
  }

  return index;
}
