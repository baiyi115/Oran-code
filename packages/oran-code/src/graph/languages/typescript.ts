import { dirname, posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveResult } from "./registry.js";

/**
 * TypeScript / TSX / JavaScript. specifier -> repo file via relative-path
 * resolution with extension completion. Bare package names are external by
 * design (tsconfig paths mapping is deliberately not supported yet).
 */

const QUERY = [
  "(import_statement source: (string) @spec)",
  "(export_statement source: (string) @spec)",
  // require("x") and dynamic import("x"); @fn is filtered against callFns.
  '(call_expression function: (identifier) @fn arguments: (arguments (string) @spec))',
].join("\n");

export const CALL_FN_NAMES: ReadonlySet<string> = new Set(["require", "import"]);

const EXACT_EXTENSIONS = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/;

export function stripQuotes(text: string): string {
  return text.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

/** ts-family extension completion order, mirroring node/ts resolution loosely. */
function candidatePaths(target: string): string[] {
  const candidates: string[] = [];
  const jsToTs: Array<[RegExp, string[]]> = [
    [/\.cjs$/, [".cts"]],
    [/\.mjs$/, [".mts"]],
    [/\.jsx$/, [".tsx"]],
    [/\.js$/, [".ts", ".tsx"]],
  ];
  if (EXACT_EXTENSIONS.test(target)) {
    candidates.push(target);
    for (const [pattern, replacements] of jsToTs) {
      if (pattern.test(target)) {
        for (const replacement of replacements) candidates.push(target.replace(pattern, replacement));
      }
    }
  }
  for (const extension of [".ts", ".tsx"]) candidates.push(target + extension);
  for (const extension of ["/index.ts", "/index.tsx"]) candidates.push(target + extension);
  return candidates;
}

export function resolveTypeScriptSpecifier(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): ResolveResult {
  if (!specifier.startsWith(".")) return { kind: "unresolved", reason: "external" };
  const target = posix.normalize(posix.join(dirname(fromFile), specifier));
  for (const candidate of candidatePaths(target)) {
    if (fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
  }
  return { kind: "unresolved", reason: "no-source" };
}

const SYMBOL_QUERIES = {
  defs: [
    "(function_declaration name: (identifier) @name) @def",
    "(class_declaration name: (type_identifier) @name) @def",
    "(method_definition name: (property_identifier) @name) @def",
    "(interface_declaration name: (type_identifier) @name) @def",
    "(type_alias_declaration name: (type_identifier) @name) @def",
  ].join("\n"),
  defKinds: ["function", "class", "method", "interface", "type"],
  calls: "(call_expression function: (identifier) @callee)",
  bindings: [
    // Child pattern before the source field: web-tree-sitter 0.25's query
    // parser rejects this shape with the field written first.
    '(import_statement (import_clause (identifier) @bind) source: (string) @src)',
    '(import_statement (import_clause (named_imports (import_specifier name: (identifier) @bind))) source: (string) @src)',
  ].join("\n"),
  inherit: [
    "(class_declaration name: (type_identifier) @class (class_heritage (extends_clause value: (identifier) @super)))",
    "(class_declaration name: (type_identifier) @class (class_heritage (implements_clause (type_identifier) @super)))",
  ].join("\n"),
};

const DEF_KINDS = ["function", "class", "method", "interface", "type"] as const;

function makeSupport(id: LanguageSupport["id"], extensions: string[], grammar: string): LanguageSupport {
  return {
    id,
    extensions,
    grammar,
    importQuery: QUERY,
    callFns: CALL_FN_NAMES,
    symbols: SYMBOL_QUERIES,
    resolve: (fromFile, specifier, context) => resolveTypeScriptSpecifier(fromFile, specifier, context.fileSet),
  };
}

export function registerTypeScriptFamily(): void {
  registerLanguage(makeSupport("typescript", [".ts", ".mts", ".cts"], "typescript"));
  registerLanguage(makeSupport("tsx", [".tsx"], "tsx"));
  registerLanguage(makeSupport("javascript", [".js", ".mjs", ".cjs", ".jsx"], "javascript"));
}
