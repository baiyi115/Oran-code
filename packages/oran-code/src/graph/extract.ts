import type { LanguageSupport } from "./languages/registry.js";
import type { QueryMatchData } from "./extract-raw.js";
import { requestQuery, requestSpecifiers } from "./worker/pool.js";

/**
 * Pool-backed extraction. Every parse runs in an isolated per-grammar worker:
 * web-tree-sitter grammars sharing one wasm instance corrupt each other
 * (a kotlin parse permanently breaks a later lua parse), so the main thread
 * never parses. The pool falls back to in-thread parsing only if workers
 * cannot spawn at all.
 */

export function stripQuotes(text: string): string {
  return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

export async function extractSpecifiers(language: LanguageSupport, source: string): Promise<string[]> {
  return requestSpecifiers(language.id, source);
}

export async function runQuery(grammar: string, query: string, source: string): Promise<QueryMatchData[]> {
  return requestQuery(grammar, query, source);
}

export async function extractTypeScriptSpecifiers(source: string): Promise<string[]> {
  return requestSpecifiers("typescript", source);
}

export function firstQuoted(text: string): string | undefined {
  return /["']([^"']+)["']/.exec(text)?.[1];
}
