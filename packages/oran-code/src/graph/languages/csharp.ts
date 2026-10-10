import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { resolveNamespaceImport } from "./namespace-shared.js";

/**
 * C#. `using Foo.Bar;` is a namespace reference: it resolves to a file only
 * when exactly one file declares that namespace — the honest limit of the
 * file model, since one namespace typically spans many files. Zero matches ->
 * external; several -> ambiguous. Static usings carry no file-level target.
 */

const QUERY = "(using_directive) @imp";
export const PACKAGE_QUERY = "(namespace_declaration name: (_) @pkg)";

function specFromMatch(captures: ReadonlyMap<string, string>): string[] {
  const imp = captures.get("imp");
  if (!imp) return [];
  const body = imp
    .replace(/^using\s+/, "")
    .replace(/;\s*$/, "")
    .trim();
  if (body.startsWith("static ")) return [];
  const name = body.split("=")[0]?.trim();
  return name ? [`n:${name}`] : [];
}

function resolve(specifier: string, context: ResolveContext): ResolveResult {
  return resolveNamespaceImport(specifier.slice(2), context);
}

export function registerCSharp(): void {
  const support: LanguageSupport = {
    id: "c_sharp",
    extensions: [".cs"],
    grammar: "c_sharp",
    importQuery: QUERY,
    packageQuery: PACKAGE_QUERY,
    specFromMatch,
    resolve: (_fromFile, specifier, context) => resolve(specifier, context),
  };
  registerLanguage(support);
}
