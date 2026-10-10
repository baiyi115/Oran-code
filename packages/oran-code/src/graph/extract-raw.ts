import type { Query } from "web-tree-sitter";
import { parseSource, queryFor } from "./runtime.js";
import { registerAllLanguages } from "./languages/all.js";
import { registeredLanguages } from "./languages/registry.js";
import type { LanguageSupport } from "./languages/registry.js";

/**
 * In-thread extraction. Only the parse worker runs this — grammars loaded
 * into one web-tree-sitter instance corrupt each other (a kotlin parse
 * permanently breaks a later lua parse), so the main thread never parses;
 * it routes through one worker per grammar instead. Parsing itself goes through
 * runtime.parseSource, which also guards against a grammar that cannot be parsed
 * twice in one process.
 */

export function stripQuotes(text: string): string {
  return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

export interface QueryCaptureData {
  name: string;
  text: string;
  row: number;
  column: number;
  endRow: number;
  endColumn: number;
}

/** One query match: its pattern index plus captured nodes. */
export interface QueryMatchData {
  pattern: number;
  captures: QueryCaptureData[];
}

export interface QueryRunResult {
  matches: QueryMatchData[];
  error?: string | undefined;
}

export interface FileAnalysis {
  specifiers: string[];
  specifierError?: string | undefined;
  /** Set when the request itself failed (host unavailable, timeout, crash). */
  requestError?: string | undefined;
  /**
   * Set when the grammar can no longer be trusted in this process (see
   * runtime.parseSource). The result is empty and the request has to be retried
   * in a fresh host process.
   */
  needsFreshProcess?: boolean | undefined;
  queries: Record<string, QueryRunResult>;
}

export interface FileAnalysisRequest {
  languageId: string;
  source: string;
  /** Extra named queries to run against the same parse (L2 symbol queries). */
  queries?: Record<string, string> | undefined;
}

/**
 * True when an analysis is *incomplete* rather than merely empty: the request
 * failed, a query did not compile or threw, or specifier extraction failed.
 *
 * The distinction matters downstream: an empty result is indistinguishable from
 * a file with no imports, so a caller that publishes one without saying so turns
 * "the file was never analyzed" into "nothing depends on this file" — the answer
 * code_impact exists to give. Callers report these files instead.
 */
export function isIncompleteAnalysis(analysis: FileAnalysis): boolean {
  if (analysis.requestError !== undefined || analysis.specifierError !== undefined) return true;
  return Object.values(analysis.queries ?? {}).some((entry) => entry?.error !== undefined);
}

function collectMatches(query: Query, rootNode: Parameters<Query["matches"]>[0]): QueryMatchData[] {
  return query.matches(rootNode).map((match) => ({
    pattern: match.pattern,
    captures: match.captures.map((capture) => ({
      name: capture.name,
      text: capture.node.text,
      row: capture.node.startPosition.row,
      column: capture.node.startPosition.column,
      endRow: capture.node.endPosition.row,
      endColumn: capture.node.endPosition.column,
    })),
  }));
}

/**
 * Run a query and return per-match capture data (text + span positions).
 * Used by the vue path, which re-parses script blocks with the ts grammar; a
 * degraded grammar yields an empty result there, which is why the vue specifier
 * extraction only ever asks for grammars that behave (see runtime.parseSource).
 */
export async function runQueryRaw(grammar: string, querySource: string, source: string): Promise<QueryMatchData[]> {
  const outcome = await parseSource(grammar, source);
  if (outcome.kind !== "parsed") return [];
  try {
    return collectMatches(queryFor(grammar, outcome.language, querySource), outcome.tree.rootNode);
  } finally {
    outcome.tree.delete();
  }
}

/**
 * One file, one parse: every query a build needs (imports plus the language's
 * symbol queries) runs against the same tree in a single request. Previously
 * each of the five queries was its own round trip that re-sent the source and
 * re-parsed it, and each query was recompiled per file.
 */
export async function analyzeFileRaw(request: FileAnalysisRequest): Promise<FileAnalysis> {
  registerAllLanguages();
  const language = registeredLanguages().find((support) => support.id === request.languageId);
  const queries: Record<string, QueryRunResult> = {};
  if (!language) return { specifiers: [], queries };
  // The parse can report that this grammar is unusable here; the caller then has
  // to retry in a fresh process instead of accepting empty results.
  const outcome = await parseSource(language.grammar, request.source);
  if (outcome.kind === "unavailable") return { specifiers: [], queries };
  if (outcome.kind === "degraded") return { specifiers: [], queries, needsFreshProcess: true };
  const { tree, language: grammarLanguage } = outcome;
  try {
    const rootNode = tree.rootNode;
    for (const [key, querySource] of Object.entries(request.queries ?? {})) {
      // Each query is caught on its own: one broken query should empty only its
      // own result, not take the rest of the file's analysis with it. The error
      // is kept so the caller can report the file as incomplete.
      try {
        queries[key] = { matches: collectMatches(queryFor(language.grammar, grammarLanguage, querySource), rootNode) };
      } catch (error) {
        queries[key] = { matches: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      const specifiers = language.extractAsync
        ? await language.extractAsync(request.source)
        : language.importQuery
          ? extractSpecifiersRaw(
              language,
              collectMatches(queryFor(language.grammar, grammarLanguage, language.importQuery), rootNode),
            )
          : [];
      return { specifiers, queries };
    } catch (error) {
      return { specifiers: [], specifierError: error instanceof Error ? error.message : String(error), queries };
    }
  } finally {
    tree.delete();
  }
}

export function firstQuoted(text: string): string | undefined {
  return /["']([^"']+)["']/.exec(text)?.[1];
}

function extractSpecifiersRaw(language: LanguageSupport, matches: readonly QueryMatchData[]): string[] {
  const specifiers: string[] = [];
  for (const match of matches) {
    const captures = new Map(match.captures.map((capture) => [capture.name, capture.text]));
    if (language.specFromMatch) {
      specifiers.push(...language.specFromMatch(captures));
      continue;
    }
    const spec = captures.get("spec");
    if (!spec) continue;
    const fn = captures.get("fn");
    if (fn && language.callFns && !language.callFns.has(fn)) continue;
    specifiers.push(stripQuotes(spec));
  }
  return specifiers;
}

export async function extractSpecifiersRawFor(languageId: string, source: string): Promise<string[]> {
  registerAllLanguages();
  const language = registeredLanguages().find((support) => support.id === languageId);
  if (!language) return [];
  if (language.extractAsync) return language.extractAsync(source);
  if (!language.importQuery) return [];
  return extractSpecifiersRaw(language, await runQueryRaw(language.grammar, language.importQuery, source));
}

export async function extractTypeScriptSpecifiersRaw(source: string): Promise<string[]> {
  const { CALL_FN_NAMES } = await import("./languages/typescript.js");
  const matches = await runQueryRaw(
    "typescript",
    [
      "(import_statement source: (string) @spec)",
      "(export_statement source: (string) @spec)",
      "(call_expression function: (identifier) @fn arguments: (arguments (string) @spec))",
    ].join("\n"),
    source,
  );
  const specifiers: string[] = [];
  for (const match of matches) {
    const captures = new Map(match.captures.map((capture) => [capture.name, capture.text]));
    const spec = captures.get("spec");
    if (!spec) continue;
    const fn = captures.get("fn");
    if (fn && !CALL_FN_NAMES.has(fn)) continue;
    specifiers.push(stripQuotes(spec));
  }
  return specifiers;
}

const VUE_SCRIPT_QUERY = "(script_element (raw_text) @script)";

export async function extractVueSpecifiersRaw(source: string): Promise<string[]> {
  const matches = await runQueryRaw("vue", VUE_SCRIPT_QUERY, source);
  const blocks = matches.flatMap((match) =>
    match.captures.filter((capture) => capture.name === "script").map((capture) => capture.text),
  );
  const specifiers: string[] = [];
  for (const block of blocks) specifiers.push(...(await extractTypeScriptSpecifiersRaw(block)));
  return specifiers;
}
