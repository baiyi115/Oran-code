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
 * 编译后的查询按 (grammar, querySource) 缓存。`new Query` 会把 pattern 编译进
 * 字节码,是这条管线上最贵的一步(实测约 7.7ms/条,而解析一个 53KB 的文件只要
 * 15.6ms);同一份查询此前每解析一个文件就要重编一次。查询绑定在某个 Language
 * 实例上,而实例与宿主进程同生命周期,所以缓存是安全的。
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
 * 有些语法在**同一个进程里只能解析一次**:第二次起同一个源会解析成 ERROR 树。
 *
 * 实测(web-tree-sitter 0.25.10 + tree-sitter-wasms 0.1.13)lua 就是这样,而
 * python / typescript / bash 正常:连续 4 次解析得到 ok,ERR,ERR,ERR,换新
 * Parser、换新 Query、换输入长度、乃至在同一进程里重新 Language.load 一个
 * 全新的实例(它的第一次解析也直接 ERR)都不改变结论。也就是说这不是缓存或
 * 对象复用的问题,损坏发生在进程级,唯一可靠的办法是换进程。后果曾经是
 * 「一个仓库里第二个 .lua 文件起,import 边静默消失」。
 *
 * 判定方式:一个在本进程里解析干净过的语法,突然给出带错误的树 —— 那不是文件
 * 的问题。此时不采信这次结果,交给上层换进程重试;并记住这个语法,之后不再
 * 浪费那一次解析。
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
