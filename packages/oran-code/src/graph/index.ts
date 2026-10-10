import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { walkFiles } from "../tools/glob.js";
import { extractSpecifiers, runQuery, stripQuotes } from "./extract.js";
import type { QueryMatchData } from "./extract-raw.js";
import { loadConfigSnapshot } from "./resolve/config.js";
import { registerAllLanguages } from "./languages/all.js";
import {
  languageForFile,
  registeredLanguages,
  type CallEdge,
  type GraphIndex,
  type InheritanceEdge,
  type LanguageSupport,
  type ResolveContext,
  type SymbolNode,
  type UnresolvedImport,
} from "./languages/registry.js";

function ensureLanguagesRegistered(): void {
  registerAllLanguages();
}

/** A broken query in one language must never fail the whole build. */
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

export interface ScannedSource {
  path: string;
  mtimeMs: number;
}

/** Directory walk reusing the shared ignore rules; state directories excluded. */
export async function scanSources(root: string): Promise<ScannedSource[]> {
  const scanned: ScannedSource[] = [];
  ensureLanguagesRegistered();
  const extensions = new Set(registeredLanguages().flatMap((language) => language.extensions));
  await walkFiles(root, async (filePath, mtimeMs) => {
    const relative = filePath.slice(root.length).replaceAll("\\", "/").replace(/^\//, "");
    const dot = relative.lastIndexOf(".");
    if (dot < 0) return;
    if (!extensions.has(relative.slice(dot).toLowerCase())) return;
    // Declaration files are build artifacts, not sources.
    if (relative.endsWith(".d.ts")) return;
    scanned.push({ path: relative, mtimeMs });
  });
  scanned.sort((left, right) => left.path.localeCompare(right.path));
  return scanned;
}

/** Short fingerprint over path + mtime; no content reads. */
export function fingerprintSources(scanned: readonly ScannedSource[]): string {
  const material = scanned.map((file) => `${file.path}:${file.mtimeMs}`).join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** package/namespace -> files declaring it; needed by java/kotlin/scala/c# resolution. */
async function buildPackageIndex(
  workspace: string,
  filesByLanguage: ReadonlyMap<LanguageSupport, ScannedSource[]>,
): Promise<Map<string, string[]>> {
  const packageIndex = new Map<string, string[]>();
  for (const [support, files] of filesByLanguage) {
    if (!support.packageQuery) continue;
    for (const file of files) {
      const source = await readFile(`${workspace}/${file.path}`, "utf8").catch(() => "");
      if (!source) continue;
      for (const match of await safeQuery(support.grammar, support.packageQuery, source)) {
        for (const capture of match.captures) {
          if (capture.name !== "pkg") continue;
          const pkg = capture.text.replace(/^(?:package|namespace)\s+/, "").replace(/;\s*$/, "").trim();
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

export async function buildGraph(workspace: string, scanned: readonly ScannedSource[]): Promise<GraphIndex> {
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

  const sourceCache = new Map<string, string>();
  const readSource = async (path: string): Promise<string> => {
    let source = sourceCache.get(path);
    if (source === undefined) {
      try {
        source = await readFile(`${workspace}/${path}`, "utf8");
      } catch {
        source = "";
      }
      sourceCache.set(path, source);
    }
    return source;
  };
  for (const [support, files] of filesByLanguage) {
    for (const file of files) {
      const source = await readSource(file.path);
      if (!source) continue;

      const direct: string[] = [];
      const unresolved: UnresolvedImport[] = [];
      for (const specifier of await safeSpecifiers(support, source)) {
        const result = support.resolve(file.path, specifier, resolveContext);
        if (result.kind === "resolved") {
          for (const target of result.paths) {
            if (target !== file.path && !direct.includes(target)) direct.push(target);
          }
        } else if (!unresolved.some((item) => item.specifier === specifier && item.reason === result.reason)) {
          unresolved.push({ specifier, reason: result.reason });
        }
      }
      if (direct.length > 0) index.imports[file.path] = direct.sort();
      if (unresolved.length > 0) index.unresolved[file.path] = unresolved;
    }
  }

  const symbolLayer = await buildSymbolLayer(filesByLanguage, resolveContext, readSource);
  if (symbolLayer.symbols.length > 0) {
    index.symbols = symbolLayer.symbols;
    index.calls = symbolLayer.calls;
    index.extendsEdges = symbolLayer.extendsEdges;
  }
  return index;
}

/**
 * L2: symbol table plus statically determined call/inheritance edges for the
 * languages that declare symbol queries (ts family, python). Only unambiguous
 * targets produce edges — interface dispatch and name collisions are skipped
 * rather than guessed.
 */
async function buildSymbolLayer(
  filesByLanguage: ReadonlyMap<LanguageSupport, ScannedSource[]>,
  resolveContext: ResolveContext,
  readSource: (path: string) => Promise<string>,
): Promise<{ symbols: SymbolNode[]; calls: CallEdge[]; extendsEdges: InheritanceEdge[] }> {
  const symbols: SymbolNode[] = [];
  const defsByFile = new Map<string, DefSpan[]>();
  const byName = new Map<string, SymbolNode[]>();

  for (const [support, files] of filesByLanguage) {
    if (!support.symbols) continue;
    for (const file of files) {
      const source = await readSource(file.path);
      if (!source) continue;
      const spans: DefSpan[] = [];
      for (const match of await safeQuery(support.grammar, support.symbols.defs, source)) {
        const nameCapture = match.captures.find((capture) => capture.name === "name");
        const defCapture = match.captures.find((capture) => capture.name === "def");
        const kind = support.symbols.defKinds[match.pattern];
        if (!nameCapture || !defCapture || !kind) continue;
        const node: SymbolNode = {
          id: `${file.path}#${nameCapture.text}`,
          file: file.path,
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
        symbols.push(node);
        const bucket = byName.get(node.name);
        if (bucket) bucket.push(node);
        else byName.set(node.name, [node]);
      }
      if (spans.length > 0) defsByFile.set(file.path, spans);
    }
  }

  const resolveSymbolTarget = (file: string, name: string, bindings: Map<string, string>): SymbolNode | undefined => {
    const sameFile = defsByFile.get(file)?.find((span) => span.node.name === name)?.node;
    if (sameFile) return sameFile;
    const importedFile = bindings.get(name);
    if (importedFile !== undefined) {
      const candidates = (byName.get(name) ?? []).filter((node) => node.file === importedFile);
      if (candidates.length === 1) return candidates[0];
    }
    return undefined;
  };

  const calls: CallEdge[] = [];
  const callEdgesSeen = new Set<string>();
  const extendsEdges: InheritanceEdge[] = [];

  for (const [support, files] of filesByLanguage) {
    if (!support.symbols) continue;
    for (const file of files) {
      const spans = defsByFile.get(file.path);
      if (!spans) continue;
      const source = await readSource(file.path);
      if (!source) continue;

      const bindings = new Map<string, string>();
      for (const match of await safeQuery(support.grammar, support.symbols.bindings, source)) {
        const bind = match.captures.find((capture) => capture.name === "bind");
        const src = match.captures.find((capture) => capture.name === "src");
        if (!bind || !src) continue;
        const result = support.resolve(file.path, stripQuotes(src.text), resolveContext);
        if (result.kind === "resolved" && result.paths[0] !== undefined) bindings.set(bind.text, result.paths[0]);
      }

      for (const match of await safeQuery(support.grammar, support.symbols.calls, source)) {
        const callee = match.captures.find((capture) => capture.name === "callee");
        if (!callee) continue;
        const owner = innermostOwner(spans, callee.row, callee.column);
        if (!owner) continue;
        const target = resolveSymbolTarget(file.path, callee.text, bindings);
        if (!target) continue;
        const from = owner.node.id;
        const key = `${from}->${target.id}`;
        if (from === target.id || callEdgesSeen.has(key)) continue;
        callEdgesSeen.add(key);
        calls.push({ from, to: target.id, provenance: "resolved" });
      }

      for (const match of await safeQuery(support.grammar, support.symbols.inherit, source)) {
        const klass = match.captures.find((capture) => capture.name === "class");
        const superName = match.captures.find((capture) => capture.name === "super");
        if (!klass || !superName) continue;
        const target = resolveSymbolTarget(file.path, superName.text, bindings);
        if (!target) continue;
        extendsEdges.push({ from: `${file.path}#${klass.text}`, to: target.id });
      }
    }
  }

  return { symbols, calls, extendsEdges };
}

interface DefSpan {
  node: SymbolNode;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

function contains(span: DefSpan, row: number, column: number): boolean {
  const afterStart = span.startRow < row || (span.startRow === row && span.startColumn <= column);
  const beforeEnd = span.endRow > row || (span.endRow === row && span.endColumn >= column);
  return afterStart && beforeEnd;
}

/** Innermost definition containing the position, if any. */
function innermostOwner(spans: DefSpan[], row: number, column: number): DefSpan | undefined {
  let best: DefSpan | undefined;
  for (const span of spans) {
    if (!contains(span, row, column)) continue;
    // The smallest containing span is the innermost owner.
    if (!best || span.startRow > best.startRow || (span.startRow === best.startRow && span.startColumn > best.startColumn)) {
      best = span;
    }
  }
  return best;
}
