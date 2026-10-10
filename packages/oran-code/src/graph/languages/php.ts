import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { firstQuoted } from "../extract.js";

/**
 * PHP. Two channels:
 * - use statements are class imports resolved through composer.json psr-4
 *   prefixes, falling back to a unique repo-wide suffix match (App/Foo.php);
 * - require/include resolve relative to the file (incl. __DIR__ concat) and
 *   fall back to a unique suffix match; dynamic expressions stay dynamic.
 */

const QUERY = [
  "(namespace_use_clause (qualified_name) @spec)",
  "(require_expression) @req",
  "(require_once_expression) @req",
  "(include_expression) @req",
  "(include_once_expression) @req",
].join("\n");

function specFromMatch(captures: ReadonlyMap<string, string>): string[] {
  const use = captures.get("spec");
  if (use) return [`u:${use.split(/\s+as\s+/)[0]?.trim() ?? ""}`];
  const req = captures.get("req");
  return req ? [`r:${req}`] : [];
}

function uniqueSuffixMatch(fileSet: ReadonlySet<string>, suffix: string): ResolveResult | undefined {
  const matches = [...fileSet].filter((file) => file === suffix || file.endsWith(`/${suffix}`)).sort();
  if (matches.length === 1) return { kind: "resolved", paths: matches };
  if (matches.length > 1) return { kind: "unresolved", reason: "ambiguous" };
  return undefined;
}

function resolveUse(classPath: string, context: ResolveContext): ResolveResult {
  const segments = classPath.split("\\");
  const relative = `${segments.join("/")}.php`;

  // Longest psr-4 prefix wins.
  for (let cut = segments.length - 1; cut >= 1; cut -= 1) {
    const prefix = segments.slice(0, cut).join("\\");
    const dirs = context.config.composerPsr4?.get(prefix.replaceAll("\\", "/"));
    if (!dirs) continue;
    const rest = segments.slice(cut).join("/");
    for (const dir of dirs) {
      const candidate = `${dir === "." ? "" : `${dir}/`}${rest}.php`;
      if (context.fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
    }
  }
  const fallback = uniqueSuffixMatch(context.fileSet, relative);
  return fallback ?? { kind: "unresolved", reason: "external" };
}

function resolveRequire(fromFile: string, expression: string, context: ResolveContext): ResolveResult {
  if (expression.includes("$")) return { kind: "unresolved", reason: "dynamic" };
  const dirConcat = /^__DIR__\s*\.\s*['"]([^'"]+)['"]/.exec(expression.replace(/\s+/g, " "));
  let target: string | undefined;
  if (dirConcat?.[1]) {
    target = posix.normalize(posix.join(posix.dirname(fromFile), dirConcat[1]));
    return context.fileSet.has(target)
      ? { kind: "resolved", paths: [target] }
      : { kind: "unresolved", reason: "no-source" };
  }
  const literal = firstQuoted(expression);
  if (!literal) return { kind: "unresolved", reason: "dynamic" };
  const relative = posix.normalize(posix.join(posix.dirname(fromFile), literal));
  if (context.fileSet.has(relative)) return { kind: "resolved", paths: [relative] };
  // Plain includes go through the include path; a unique repo-wide match is
  // the only honest guess, anything else is configuration we do not have.
  if (!literal.startsWith(".")) {
    const fallback = uniqueSuffixMatch(context.fileSet, literal);
    if (fallback) return fallback;
    return { kind: "unresolved", reason: "needs-config" };
  }
  return { kind: "unresolved", reason: "no-source" };
}

export function resolvePhpSpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  return specifier.startsWith("u:")
    ? resolveUse(specifier.slice(2), context)
    : resolveRequire(fromFile, specifier.slice(2), context);
}

export function registerPhp(): void {
  const support: LanguageSupport = {
    id: "php",
    extensions: [".php"],
    grammar: "php",
    importQuery: QUERY,
    specFromMatch,
    resolve: resolvePhpSpecifier,
  };
  registerLanguage(support);
}
