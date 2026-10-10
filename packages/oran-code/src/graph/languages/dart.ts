import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";

/**
 * Dart. Relative URIs resolve directly; `package:<name>/path` resolves into
 * <name>/lib/path, which works inside a repo for the package itself (via
 * pubspec.yaml's name) and for workspace siblings. dart: URIs are external.
 */

const QUERY = "(uri) @spec";

export function resolveDartSpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  if (!specifier) return { kind: "unresolved", reason: "dynamic" };
  if (specifier.startsWith("dart:")) return { kind: "unresolved", reason: "external" };

  const packageMatch = /^package:([^/]+)\/(.+)$/.exec(specifier);
  if (packageMatch) {
    const [, name, path] = packageMatch;
    // The package itself lives at the repo root (pubspec.yaml's directory);
    // sibling packages in a monorepo live under their own directory.
    const candidate = name === context.config.dartPackageName ? `lib/${path}` : `${name}/lib/${path}`;
    if (context.fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
    return name === context.config.dartPackageName ? { kind: "unresolved", reason: "no-source" } : { kind: "unresolved", reason: "external" };
  }

  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return context.fileSet.has(target) ? { kind: "resolved", paths: [target] } : { kind: "unresolved", reason: "no-source" };
}

export function registerDart(): void {
  const support: LanguageSupport = {
    id: "dart",
    extensions: [".dart"],
    grammar: "dart",
    importQuery: QUERY,
    resolve: resolveDartSpecifier,
  };
  registerLanguage(support);
}
