import type { LanguageSupport } from "./languages/registry.js";
import type { FileAnalysis } from "./extract-raw.js";
import { requestFileAnalysis } from "./worker/pool.js";

/**
 * Pool-backed extraction. Every file is analyzed by the isolated host that owns
 * its grammar: web-tree-sitter grammars sharing one wasm instance corrupt each
 * other (a kotlin parse permanently breaks a later lua parse), so the main
 * thread never parses. The pool falls back to in-thread parsing only if workers
 * cannot spawn at all.
 */

export function stripQuotes(text: string): string {
  return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

export function firstQuoted(text: string): string | undefined {
  return /["']([^"']+)["']/.exec(text)?.[1];
}

/** The L2 queries a language declares, keyed for the aggregate request. */
export function symbolQueries(support: LanguageSupport): Record<string, string> {
  const symbols = support.symbols;
  if (!symbols) return {};
  return { defs: symbols.defs, bindings: symbols.bindings, calls: symbols.calls, inherit: symbols.inherit };
}

/**
 * Analyze one file in one round trip: the import query plus whatever extra
 * queries the caller needs, all against a single parse.
 *
 * A failed request degrades to an empty analysis for that file rather than
 * failing the build, but the failure is *reported* (requestError) so the caller
 * can count it and say so instead of publishing a file with no edges — the same
 * silent degradation this used to be, with nothing to distinguish "no imports"
 * from "never parsed".
 */
export async function analyzeFile(
  language: LanguageSupport,
  source: string,
  queries: Record<string, string> = {},
): Promise<FileAnalysis> {
  try {
    return await requestFileAnalysis(language.id, source, queries);
  } catch (error) {
    return {
      specifiers: [],
      requestError: error instanceof Error ? error.message : String(error),
      queries: {},
    };
  }
}
