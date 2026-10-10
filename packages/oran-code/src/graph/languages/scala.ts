import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { resolveClassImport, resolveWildcardImport } from "./namespace-shared.js";

/**
 * Scala. Package clause + import resolution through the package index, like
 * java/kotlin. Member selects (`import a.B.{C, D}`) split into per-class
 * imports; trailing `._` is the wildcard form.
 */

const QUERY = "(import_declaration) @imp";
export const PACKAGE_QUERY = "(package_clause name: (package_identifier) @pkg)";

function specFromMatch(captures: ReadonlyMap<string, string>): string[] {
  const imp = captures.get("imp");
  if (!imp) return [];
  const body = imp
    .replace(/^import\s+/, "")
    .replace(/;\s*$/, "")
    .trim();
  const renamed = body.split(/\s+as\s+/)[0]?.trim() ?? body;

  const brace = /\{([^}]+)\}$/.exec(renamed);
  if (brace?.[1]) {
    const prefix = renamed.slice(0, renamed.lastIndexOf("{")).replace(/\.$/, "");
    return brace[1]
      .split(",")
      .map((member) => member.trim().split(/\s+/)[0])
      .filter((member) => member && member !== "_")
      .map((member) => `j:${prefix}.${member}`);
  }
  if (renamed.endsWith("._")) return [`jw:${renamed.slice(0, -2)}`];
  return renamed.includes(".") ? [`j:${renamed}`] : [];
}

function resolve(specifier: string, context: ResolveContext): ResolveResult {
  const body = specifier.slice(2);
  if (specifier.startsWith("jw:")) return resolveWildcardImport(body, context);
  const dot = body.lastIndexOf(".");
  return resolveClassImport(body.slice(0, dot), body.slice(dot + 1), context);
}

export function registerScala(): void {
  const support: LanguageSupport = {
    id: "scala",
    extensions: [".scala", ".sc"],
    grammar: "scala",
    importQuery: QUERY,
    packageQuery: PACKAGE_QUERY,
    specFromMatch,
    resolve: (_fromFile, specifier, context) => resolve(specifier, context),
  };
  registerLanguage(support);
}
