import { Parser, Language, Query, type Tree } from "web-tree-sitter";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

/**
 * wasm runtime: initialized once per process; grammars load lazily per
 * language and one parser is reused per grammar (they are stateful).
 *
 * The exports map of web-tree-sitter does not allow "./package.json", so the
 * runtime directory is derived from the resolved main entry. Grammar files
 * come from tree-sitter-wasms/out/tree-sitter-<grammar>.wasm.
 *
 * Version pairing is load-bearing: web-tree-sitter 0.27 cannot load the
 * tree-sitter-wasms 0.1.13 grammars (dylink metadata mismatch); 0.25.x can.
 *
 * This module also owns the compiled-query cache and the parse guard, because
 * both are bound to a specific Language instance and so have to be invalidated
 * together with it.
 */

const require = createRequire(import.meta.url);
const RUNTIME_DIRECTORY = dirname(require.resolve("web-tree-sitter"));
const GRAMMAR_DIRECTORY = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Promise<Parser>>();

/**
 * Compiled queries are cached by (grammar, querySource). `new Query` compiles the pattern into
 * bytecode, the most expensive step in this pipeline (measured at ~7.7ms per query, while parsing
 * a 53KB file takes only 15.6ms); the same query used to be recompiled for every file parsed.
 * A query is bound to a Language instance, and the instance shares the host process's lifetime,
 * so caching is safe.
 */
const queryCache = new Map<string, Query>();

export function initParserRuntime(): Promise<void> {
  initPromise ??= Parser.init({ locateFile: (script: string) => join(RUNTIME_DIRECTORY, script) });
  return initPromise;
}

export function loadLanguage(grammar: string): Promise<Language> {
  let pending = languageCache.get(grammar);
  if (!pending) {
    pending = (async () => {
      await initParserRuntime();
      return Language.load(join(GRAMMAR_DIRECTORY, `tree-sitter-${grammar}.wasm`));
    })();
    languageCache.set(grammar, pending);
  }
  return pending;
}

export function getParser(grammar: string): Promise<Parser> {
  let pending = parserCache.get(grammar);
  if (!pending) {
    pending = (async () => {
      const language = await loadLanguage(grammar);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parserCache.set(grammar, pending);
  }
  return pending;
}

export function queryFor(grammar: string, grammarLanguage: Language, querySource: string): Query {
  const key = `${grammar}\u0000${querySource}`;
  let query = queryCache.get(key);
  if (!query) {
    query = new Query(grammarLanguage, querySource);
    queryCache.set(key, query);
  }
  return query;
}

/**
 * Some grammars can parse only **once within the same process**: from the second call on, the same
 * source parses into an ERROR tree.
 *
 * Measured (web-tree-sitter 0.25.10 + tree-sitter-wasms 0.1.13): this holds for lua, while
 * python / typescript / bash are fine — 4 parses in a row yield ok,ERR,ERR,ERR, and a fresh
 * Parser, a fresh Query, a different input length, even re-loading a brand-new Language instance
 * in the same process (whose very first parse is ERR as well) all leave the conclusion unchanged.
 * So this is not a caching or object-reuse problem: the corruption happens at process level, and
 * the only reliable remedy is a new process. The consequence used to be "from the second .lua file
 * in a repository onward, import edges silently disappeared".
 *
 * Detection: a grammar that has already parsed cleanly in this process suddenly hands back a tree
 * with errors — that is not the file's fault. The result is then not trusted, the caller is left
 * to retry in a new process, and the grammar is remembered so that wasted parse is not repeated.
 */
const processScopedGrammars = new Set<string>();
/**
 * The last source that parsed cleanly, per grammar. It is the control for telling
 * "this file has syntax errors" (normal) from "this grammar stopped working"
 * (the lua case): a source that already parsed cleanly cannot have become
 * malformed, so if it reports errors now, the grammar is at fault.
 */
const lastCleanSource = new Map<string, string>();

export type ParseOutcome =
  | { kind: "parsed"; tree: Tree; language: Language }
  /** The grammar cannot be trusted in this process any more; retry in a new one. */
  | { kind: "degraded" }
  /** The parser returned no tree at all. */
  | { kind: "unavailable" };

/**
 * Parse one source, refusing to trust a grammar that has stopped working in this
 * process. A file that merely has syntax errors is not evidence of that, so an
 * error tree is only acted on when re-parsing the last known-clean source also
 * fails.
 */
export async function parseSource(grammar: string, source: string): Promise<ParseOutcome> {
  const [parser, language] = await Promise.all([getParser(grammar), loadLanguage(grammar)]);
  if (processScopedGrammars.has(grammar)) return { kind: "degraded" };
  const tree = parser.parse(source);
  if (!tree) return { kind: "unavailable" };
  if (!tree.rootNode.hasError) {
    lastCleanSource.set(grammar, source);
    return { kind: "parsed", tree, language };
  }
  const control = lastCleanSource.get(grammar);
  if (control === undefined) return { kind: "parsed", tree, language };
  const verification = parser.parse(control);
  const grammarBroken = verification === null || verification.rootNode.hasError;
  verification?.delete();
  if (!grammarBroken) return { kind: "parsed", tree, language };
  tree.delete();
  processScopedGrammars.add(grammar);
  return { kind: "degraded" };
}
