/**
 * Shared data model for the code impact graph. Nodes are files, edges are
 * imports (file level); optional symbol-level data (L2) rides on the same
 * index. Reverse indexes are computed at query time, never persisted.
 */

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "c_sharp"
  | "php"
  | "ruby"
  | "kotlin"
  | "swift"
  | "scala"
  | "lua"
  | "bash"
  | "vue"
  | "dart";

export type UnresolvedReason =
  /** Bare package names, standard library, outside the repo — by design. */
  | "external"
  /** A path was derived but no such file exists in the repo — a real gap. */
  | "no-source"
  /** Resolution needs build config that is missing or unsupported — a real gap. */
  | "needs-config"
  /** The mapping is inherently not unique (namespace -> file) — lossy. */
  | "ambiguous"
  /** Only decidable at runtime (dynamic import, reflection) — by design. */
  | "dynamic";

export interface UnresolvedImport {
  specifier: string;
  reason: UnresolvedReason;
}

export interface SymbolNode {
  /** Globally unique: `<file>#<name>`. */
  id: string;
  file: string;
  kind: "function" | "class" | "method" | "interface" | "type";
  name: string;
  /** 1-based line. */
  line: number;
}

export interface CallEdge {
  /** Caller symbol id. */
  from: string;
  /** Callee symbol id. */
  to: string;
  /** "resolved" edges are statically determined; we never emit "heuristic". */
  provenance: "resolved" | "heuristic";
}

export interface InheritanceEdge {
  from: string;
  to: string;
}

export interface GraphIndex {
  version: 1;
  builtAt: string;
  /** Language per file; files in unrecognized languages never enter the graph. */
  languages: Record<string, LanguageId>;
  /** Source files inside the repo, workspace-relative with forward slashes, sorted. */
  files: string[];
  /** file -> files it directly imports (resolved, deduplicated, sorted). Forward edges only. */
  imports: Record<string, string[]>;
  /** specifiers that could not be resolved, kept per reason class instead of dropped silently. */
  unresolved: Record<string, UnresolvedImport[]>;
  /** L2 (optional): symbol table. */
  symbols?: SymbolNode[];
  /** L2 (optional): statically determined call edges between symbols. */
  calls?: CallEdge[];
  /** L2 (optional): class inheritance edges between class symbols. */
  extendsEdges?: InheritanceEdge[];
  /**
   * Files whose analysis request failed. They are in `files` and `languages` but
   * contribute no edges, so a reader has to be told rather than left to conclude
   * that nothing imports them.
   */
  unparsed?: string[];
}

/** Per-build config snapshot, loaded once and reused for every resolution. */
export interface ConfigSnapshot {
  goModulePath?: string | undefined;
  /** Cargo.toml path dependencies: crate name -> repo directory. */
  cargoPathDeps?: ReadonlyMap<string, string> | undefined;
  /** Directory holding lib.rs/main.rs (e.g. "src"), when present. */
  rustCrateRoot?: string | undefined;
  /** composer.json psr-4 prefixes: namespace prefix -> directories. */
  composerPsr4?: ReadonlyMap<string, readonly string[]> | undefined;
  /** pubspec.yaml package name (dart package: URIs). */
  dartPackageName?: string | undefined;
}

export interface ResolveContext {
  fileSet: ReadonlySet<string>;
  config: ConfigSnapshot;
  /** package/namespace -> files declaring it (java, kotlin, scala, c_sharp). */
  packageIndex: ReadonlyMap<string, readonly string[]>;
}

export type ResolveResult = { kind: "resolved"; paths: string[] } | { kind: "unresolved"; reason: UnresolvedReason };

/** Language-specific raw import extraction. Opaque strings understood by resolve(). */
export interface RawImport {
  spec: string;
}

export interface LanguageSupport {
  id: LanguageId;
  extensions: string[];
  /** tree-sitter-wasms grammar name: tree-sitter-<grammar>.wasm */
  grammar: string;
  /** Query capturing @spec (raw specifier) and optionally @fn (call target). */
  importQuery: string;
  /**
   * When the query captures @fn, only calls whose target text is in this set
   * count as imports (e.g. require/import); matches without @fn always count.
   */
  callFns?: ReadonlySet<string> | undefined;
  /**
   * Custom per-match specifier mapping for grammars whose imports do not fit
   * the @spec/@fn shape (rust mod/use, php include, bash source...). When
   * absent, the default mapping reads @spec and filters via callFns.
   */
  specFromMatch?: ((captures: ReadonlyMap<string, string>) => string[]) | undefined;
  /** Fully custom async extraction (vue re-parses script blocks with the TS grammar). */
  extractAsync?: ((source: string) => Promise<string[]>) | undefined;
  /** Query collecting package/namespace declarations for the package index. */
  packageQuery?: string | undefined;
  resolve: (fromFile: string, specifier: string, context: ResolveContext) => ResolveResult;
  /** L2 symbol extraction queries (ts family + python). */
  symbols?: SymbolQueries | undefined;
}

/**
 * Declarative L2 queries. Pattern order in `defs` fixes the SymbolKind; each
 * pattern captures @name on the identifier and @def on the whole definition
 * node (its span assigns calls to their innermost owner). `calls` captures
 * every plain-identifier call site (@callee); `bindings` pairs local @bind
 * names with module @src specifiers; `inherit` pairs @class with @super.
 */
export interface SymbolQueries {
  defs: string;
  /** Symbol kind per `defs` pattern, in pattern order. */
  defKinds: readonly string[];
  calls: string;
  bindings: string;
  inherit: string;
}

export interface SymbolExtraction {
  /** Query capturing symbol definitions: @name, @kind ("function"|"class"|"method"|"interface"|"type"). */
  symbolQuery: string;
  /** Query capturing call targets: @callee (plain identifier calls only). */
  callQuery: string;
  /** Query capturing import bindings: @bind (local name) + @src (resolved module specifier). */
  bindingQuery: string;
  /** Query capturing class inheritance: @class (name node) + @super (name node). */
  inheritQuery: string;
}

const registry = new Map<LanguageId, LanguageSupport>();
const extensionIndex = new Map<string, LanguageSupport>();

export function registerLanguage(support: LanguageSupport): void {
  registry.set(support.id, support);
  for (const extension of support.extensions) extensionIndex.set(extension, support);
}

export function languageForFile(path: string): LanguageSupport | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return extensionIndex.get(path.slice(dot).toLowerCase());
}

export function registeredLanguages(): LanguageSupport[] {
  return [...registry.values()];
}

const LANGUAGE_LABELS: Readonly<Record<LanguageId, string>> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  c: "C",
  cpp: "C++",
  c_sharp: "C#",
  php: "PHP",
  ruby: "Ruby",
  kotlin: "Kotlin",
  swift: "Swift",
  scala: "Scala",
  lua: "Lua",
  bash: "Bash",
  vue: "Vue",
  dart: "Dart",
};

/**
 * Registered languages as display names, in registration order (common
 * languages first). Derived from the registry so a tool description or an
 * error message can never drift away from what the graph really covers.
 */
export function coveredLanguageLabels(): string[] {
  return registeredLanguages().map((language) => LANGUAGE_LABELS[language.id]);
}
