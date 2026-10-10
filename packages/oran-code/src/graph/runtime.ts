import { Parser, Language } from "web-tree-sitter";
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
 */

const require = createRequire(import.meta.url);
const RUNTIME_DIRECTORY = dirname(require.resolve("web-tree-sitter"));
const GRAMMAR_DIRECTORY = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Promise<Parser>>();

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
