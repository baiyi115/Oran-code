import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { resolveClassImport, resolveWildcardImport } from "./namespace-shared.js";

/**
 * Kotlin. Same package/class model as java: `import com.bar.Baz` resolves
 * through the package index (package header declarations), wildcards connect
 * to the whole package.
 */

const QUERY = "(import_header) @imp";
export const PACKAGE_QUERY = "(package_header (identifier) @pkg)";

function specFromMatch(captures: ReadonlyMap<string, string>): string[] {
  const imp = captures.get("imp");
  if (!imp) return [];
  const body = imp.replace(/^import\s+/, "").trim();
  if (body.endsWith(".*")) return [`jw:${body.slice(0, -2)}`];
  // Alias "import a.B as C" keeps the original target.
  const name = body.split(/\s+as\s+/)[0]?.trim();
  return name && name.includes(".") ? [`j:${name}`] : [];
}

function resolve(specifier: string, context: ResolveContext): ResolveResult {
  const body = specifier.slice(2);
  if (specifier.startsWith("jw:")) return resolveWildcardImport(body, context);
  const dot = body.lastIndexOf(".");
  return resolveClassImport(body.slice(0, dot), body.slice(dot + 1), context);
}

export function registerKotlin(): void {
  const support: LanguageSupport = {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    grammar: "kotlin",
    importQuery: QUERY,
    packageQuery: PACKAGE_QUERY,
    specFromMatch,
    resolve: (_fromFile, specifier, context) => resolve(specifier, context),
  };
  registerLanguage(support);
}
