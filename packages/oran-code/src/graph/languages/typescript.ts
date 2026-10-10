import { dirname, posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveResult, type SymbolQueries } from "./registry.js";

/**
 * TypeScript / TSX / JavaScript. specifier -> repo file via relative-path
 * resolution with extension completion. Bare package names are external by
 * design (tsconfig paths mapping is deliberately not supported yet).
 */

const QUERY = [
  "(import_statement source: (string) @spec)",
  "(export_statement source: (string) @spec)",
  // require("x") and dynamic import("x"); @fn is filtered against callFns.
  "(call_expression function: (identifier) @fn arguments: (arguments (string) @spec))",
].join("\n");

export const CALL_FN_NAMES: ReadonlySet<string> = new Set(["require", "import"]);

const EXACT_EXTENSIONS = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|vue)$/;

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
  // .vue is in the completion list because a Vue project imports its components
  // the same way it imports modules (`./components/Foo.vue` for a plain path, or
  // `./components/Foo`); without it every component looked like a leaf, since a
  // .vue file is a registered language and is therefore in the file set.
  for (const extension of [".ts", ".tsx", ".vue"]) candidates.push(target + extension);
  for (const extension of ["/index.ts", "/index.tsx", "/index.vue"]) candidates.push(target + extension);
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

/**
 * Symbol queries for the typed grammars (typescript, tsx).
 *
 * Pattern order fixes the SymbolKind through `defKinds`, so a pattern and its
 * kind are added or removed together.
 */
const TYPED_SYMBOL_QUERIES: SymbolQueries = {
  defs: [
    "(function_declaration name: (identifier) @name) @def",
    "(class_declaration name: (type_identifier) @name) @def",
    "(method_definition name: (property_identifier) @name) @def",
    "(interface_declaration name: (type_identifier) @name) @def",
    "(type_alias_declaration name: (type_identifier) @name) @def",
    // A function bound to a variable is a symbol like any other. Without this,
    // `const handler = () => {}` had no symbol, so calls to it resolved to
    // nothing and `code_impact --mode callers` reported no callers, silently.
    // Only function-valued declarators are taken, so `const limit = 10` does not
    // enter the symbol table.
    "(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def",
    // Same rule for a class field holding an arrow function.
    "(public_field_definition name: (property_identifier) @name value: (arrow_function)) @def",
  ].join("\n"),
  defKinds: ["function", "class", "method", "interface", "type", "function", "function"],
  calls: "(call_expression function: (identifier) @callee)",
  bindings: [
    // Child pattern before the source field: web-tree-sitter 0.25's query
    // parser rejects this shape with the field written first.
    "(import_statement (import_clause (identifier) @bind) source: (string) @src)",
    "(import_statement (import_clause (named_imports (import_specifier name: (identifier) @bind))) source: (string) @src)",
  ].join("\n"),
  inherit: [
    "(class_declaration name: (type_identifier) @class (class_heritage (extends_clause value: (identifier) @super)))",
    "(class_declaration name: (type_identifier) @class (class_heritage (implements_clause (type_identifier) @super)))",
  ].join("\n"),
};

/**
 * Symbol queries for the plain JavaScript grammar, which shares the file
 * extensions and the import query but not the node names: it has no
 * type_identifier, no interface_declaration and no type_alias_declaration, and
 * its class_heritage holds the base expression directly instead of an
 * extends_clause. Naming any of those in a shared query fails the whole query
 * for this grammar — tree-sitter aborts on the first unknown node — which left
 * every .js file with no symbols, no call edges and no inheritance, and (once a
 * failed query is reported as an incomplete analysis) listed them as unparsed
 * too. Verified against the grammar: compiling the shared object fails with
 * "Bad node name 'type_identifier'".
 */
const PLAIN_SYMBOL_QUERIES: SymbolQueries = {
  defs: [
    "(function_declaration name: (identifier) @name) @def",
    "(class_declaration name: (identifier) @name) @def",
    "(method_definition name: (property_identifier) @name) @def",
    "(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def",
    // The javascript grammar's class field is `field_definition` (no `name:`
    // field, so the identifier is matched positionally).
    "(field_definition (property_identifier) @name value: (arrow_function)) @def",
  ].join("\n"),
  defKinds: ["function", "class", "method", "function", "function"],
  calls: "(call_expression function: (identifier) @callee)",
  bindings: [
    "(import_statement (import_clause (identifier) @bind) source: (string) @src)",
    "(import_statement (import_clause (named_imports (import_specifier name: (identifier) @bind))) source: (string) @src)",
  ].join("\n"),
  inherit: "(class_declaration name: (identifier) @class (class_heritage (identifier) @super))",
};

function makeSupport(
  id: LanguageSupport["id"],
  extensions: string[],
  grammar: string,
  symbols: SymbolQueries,
): LanguageSupport {
  return {
    id,
    extensions,
    grammar,
    importQuery: QUERY,
    callFns: CALL_FN_NAMES,
    symbols,
    resolve: (fromFile, specifier, context) => resolveTypeScriptSpecifier(fromFile, specifier, context.fileSet),
  };
}

export function registerTypeScriptFamily(): void {
  registerLanguage(makeSupport("typescript", [".ts", ".mts", ".cts"], "typescript", TYPED_SYMBOL_QUERIES));
  registerLanguage(makeSupport("tsx", [".tsx"], "tsx", TYPED_SYMBOL_QUERIES));
  registerLanguage(makeSupport("javascript", [".js", ".mjs", ".cjs", ".jsx"], "javascript", PLAIN_SYMBOL_QUERIES));
}
