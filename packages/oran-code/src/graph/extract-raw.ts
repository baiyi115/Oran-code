import { Query } from "web-tree-sitter";
import { getParser, loadLanguage } from "./runtime.js";
import { registerAllLanguages } from "./languages/all.js";
import { registeredLanguages } from "./languages/registry.js";
import type { LanguageSupport } from "./languages/registry.js";

/**
 * In-thread extraction. Only the parse worker runs this — grammars loaded
 * into one web-tree-sitter instance corrupt each other (a kotlin parse
 * permanently breaks a later lua parse), so the main thread never parses;
 * it routes through one worker per grammar instead.
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

/** Run a query and return per-match capture data (text + span positions). */
export async function runQueryRaw(grammar: string, querySource: string, source: string): Promise<QueryMatchData[]> {
  const [parser, grammarLanguage] = await Promise.all([getParser(grammar), loadLanguage(grammar)]);
  const tree = parser.parse(source);
  if (!tree) return [];
  const query = new Query(grammarLanguage, querySource);
  try {
    return query.matches(tree.rootNode).map((match) => ({
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
  } finally {
    query.delete();
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
      '(call_expression function: (identifier) @fn arguments: (arguments (string) @spec))',
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
