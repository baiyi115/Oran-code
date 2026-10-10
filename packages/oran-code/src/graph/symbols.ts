import type { FileAnalysis, QueryCaptureData, QueryMatchData } from "./extract-raw.js";
import { stripQuotes } from "./extract.js";
import type { CallEdge, InheritanceEdge, LanguageSupport, ResolveContext, SymbolNode } from "./languages/registry.js";

/**
 * Symbol-level (L2) extraction and resolution, shared by the full build and the
 * incremental rebuild. It used to exist twice, once per path, and the two copies
 * had already started to drift.
 *
 * The split matters for performance: reading one file yields the definitions and
 * the *unresolved* call sites, and resolution happens later against the global
 * name table. Call sites are therefore held as two strings instead of the parse
 * matches that produced them, so a file never has to be parsed twice.
 */

/** A definition together with the span that owns the calls inside it. */
export interface DefSpan {
  node: SymbolNode;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

/** A call site whose target is only known once every file's definitions are in. */
export interface PendingCall {
  file: string;
  /**
   * Symbol id of the innermost definition containing the call, or the module id
   * when the call sits at file scope (see moduleSymbolId).
   */
  from: string;
  callee: string;
}

export interface PendingInherit {
  file: string;
  from: string;
  superName: string;
}

export interface FileSymbols {
  symbols: SymbolNode[];
  /** This file's definitions by name, for same-file resolution. */
  defsByName: Map<string, SymbolNode>;
  /** Local name -> resolved file, from the file's import statements. */
  bindings: Map<string, string>;
  calls: PendingCall[];
  inherits: PendingInherit[];
}

function capture(match: QueryMatchData, name: string): QueryCaptureData | undefined {
  return match.captures.find((entry) => entry.name === name);
}

function contains(span: DefSpan, row: number, column: number): boolean {
  const afterStart = span.startRow < row || (span.startRow === row && span.startColumn <= column);
  const beforeEnd = span.endRow > row || (span.endRow === row && span.endColumn >= column);
  return afterStart && beforeEnd;
}

/**
 * Symbol id for a call site that sits outside every definition: file-scope code
 * belongs to the module. It is not a definition and never enters
 * `index.symbols` — an identifier cannot contain `<`, so it cannot collide with
 * a declared name — but `from` only needs to be stable and file-scoped for the
 * edge to be reported and for the incremental rebuild to keep it.
 */
export function moduleSymbolId(file: string): string {
  return `${file}#<module>`;
}

/** Innermost definition containing the position, if any. */
function innermostOwner(spans: readonly DefSpan[], row: number, column: number): DefSpan | undefined {
  let best: DefSpan | undefined;
  for (const span of spans) {
    if (!contains(span, row, column)) continue;
    // The smallest containing span is the innermost owner.
    if (
      !best ||
      span.startRow > best.startRow ||
      (span.startRow === best.startRow && span.startColumn > best.startColumn)
    ) {
      best = span;
    }
  }
  return best;
}

/** Everything one file contributes to the symbol layer, from one analysis. */
export function readFileSymbols(
  support: LanguageSupport,
  file: string,
  analysis: FileAnalysis,
  context: ResolveContext,
): FileSymbols {
  const symbols: SymbolNode[] = [];
  const defsByName = new Map<string, SymbolNode>();
  const spans: DefSpan[] = [];

  for (const match of analysis.queries.defs?.matches ?? []) {
    const name = capture(match, "name");
    const definition = capture(match, "def");
    const kind = support.symbols?.defKinds[match.pattern];
    if (!name || !definition || !kind) continue;
    const id = `${file}#${name.text}`;
    // First definition wins: a name reused in one file stays one symbol.
    if (spans.some((existing) => existing.node.id === id)) continue;
    const node: SymbolNode = { id, file, kind: kind as SymbolNode["kind"], name: name.text, line: name.row + 1 };
    spans.push({
      node,
      startRow: definition.row,
      startColumn: definition.column,
      endRow: definition.endRow,
      endColumn: definition.endColumn,
    });
    symbols.push(node);
    if (!defsByName.has(node.name)) defsByName.set(node.name, node);
  }

  const bindings = new Map<string, string>();
  for (const match of analysis.queries.bindings?.matches ?? []) {
    const bind = capture(match, "bind");
    const source = capture(match, "src");
    if (!bind || !source) continue;
    const result = support.resolve(file, stripQuotes(source.text), context);
    if (result.kind === "resolved" && result.paths[0] !== undefined) bindings.set(bind.text, result.paths[0]);
  }

  const calls: PendingCall[] = [];
  for (const match of analysis.queries.calls?.matches ?? []) {
    const callee = capture(match, "callee");
    if (!callee) continue;
    // A call outside every definition belongs to the module. Requiring an
    // enclosing definition dropped those silently, and they are not rare: module
    // init, a script's top level, python's `if __name__ == "__main__": main()`.
    const owner = innermostOwner(spans, callee.row, callee.column);
    calls.push({ file, from: owner?.node.id ?? moduleSymbolId(file), callee: callee.text });
  }

  const inherits: PendingInherit[] = [];
  for (const match of analysis.queries.inherit?.matches ?? []) {
    const klass = capture(match, "class");
    const superName = capture(match, "super");
    if (!klass || !superName) continue;
    inherits.push({ file, from: `${file}#${klass.text}`, superName: superName.text });
  }

  return { symbols, defsByName, bindings, calls, inherits };
}

/**
 * Resolve a name to a symbol: a definition in the same file first, then the file
 * named by an import binding — and only when that file holds exactly one symbol
 * of that name. Ambiguity produces no edge rather than a guess.
 */
export function resolveSymbolTarget(
  defsByName: ReadonlyMap<string, SymbolNode> | undefined,
  bindings: ReadonlyMap<string, string> | undefined,
  byName: ReadonlyMap<string, SymbolNode[]>,
  name: string,
): SymbolNode | undefined {
  const local = defsByName?.get(name);
  if (local) return local;
  const importedFile = bindings?.get(name);
  if (importedFile !== undefined) {
    const candidates = (byName.get(name) ?? []).filter((node) => node.file === importedFile);
    if (candidates.length === 1) return candidates[0];
  }
  return undefined;
}

export interface SymbolResolutionScope {
  defsByNameByFile: ReadonlyMap<string, ReadonlyMap<string, SymbolNode>>;
  bindingsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>;
  byName: ReadonlyMap<string, SymbolNode[]>;
}

export function resolveCalls(
  pending: readonly PendingCall[],
  scope: SymbolResolutionScope,
  seen: Set<string>,
): CallEdge[] {
  const edges: CallEdge[] = [];
  for (const call of pending) {
    const target = resolveSymbolTarget(
      scope.defsByNameByFile.get(call.file),
      scope.bindingsByFile.get(call.file),
      scope.byName,
      call.callee,
    );
    if (!target || target.id === call.from) continue;
    const key = `${call.from}->${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: call.from, to: target.id, provenance: "resolved" });
  }
  return edges;
}

export function resolveInherits(pending: readonly PendingInherit[], scope: SymbolResolutionScope): InheritanceEdge[] {
  const edges: InheritanceEdge[] = [];
  for (const inherit of pending) {
    const target = resolveSymbolTarget(
      scope.defsByNameByFile.get(inherit.file),
      scope.bindingsByFile.get(inherit.file),
      scope.byName,
      inherit.superName,
    );
    if (!target) continue;
    edges.push({ from: inherit.from, to: target.id });
  }
  return edges;
}
