import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { resolveClassImport, resolveWildcardImport } from "./namespace-shared.js";

/**
 * Java. A class import resolves exactly when the package index contains
 * exactly one file of that class name (public-class-per-file convention);
 * wildcard imports connect to the whole package, the namespace-level edge the
 * file model can honestly express. Imports whose package exists but class
 * does not are no-source; packages absent from the repo are external.
 *
 * Specifier encoding (parsed from the import statement text):
 *   j:<pkg>.<Type>        class import
 *   js:<pkg>.<Type>.<m>   static member import (member already stripped)
 *   jw:<pkg>              wildcard import (com.foo.*)
 */

const QUERY = "(import_declaration) @imp";
export const PACKAGE_QUERY = "(package_declaration (_) @pkg)";

function specFromMatch(captures: ReadonlyMap<string, string>): string[] {
  const imp = captures.get("imp");
  if (!imp) return [];
  const body = imp
    .replace(/^import\s+/, "")
    .replace(/;\s*$/, "")
    .trim();
  if (body.startsWith("static ")) {
    const segments = body.slice(7).trim().split(".");
    if (segments.length < 2) return [];
    segments.splice(segments.length - 2, 1); // drop the member; keep pkg + Class
    return [`js:${segments.join(".")}`];
  }
  if (body.endsWith(".*")) return [`jw:${body.slice(0, -2)}`];
  return body.includes(".") ? [`j:${body}`] : [];
}

export function resolveJavaSpecifier(specifier: string, context: ResolveContext): ResolveResult {
  const kind = specifier.slice(0, 3);
  const body = specifier.slice(3);
  if (kind === "jw:") return resolveWildcardImport(body, context);
  // Static and plain imports both resolve by package + class.
  const dot = body.lastIndexOf(".");
  return resolveClassImport(body.slice(0, dot), body.slice(dot + 1), context);
}

export function registerJava(): void {
  const support: LanguageSupport = {
    id: "java",
    extensions: [".java"],
    grammar: "java",
    importQuery: QUERY,
    packageQuery: PACKAGE_QUERY,
    specFromMatch,
    resolve: (_fromFile, specifier, context) => resolveJavaSpecifier(specifier, context),
  };
  registerLanguage(support);
}
