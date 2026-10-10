import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { firstQuoted, stripQuotes } from "../extract.js";

/**
 * Bash. Only `source`/`.` with a literal path-like argument resolves (file
 * dir first, then the workspace root). PATH lookups and expansions are
 * runtime decisions and stay dynamic.
 */

const QUERY = "(command name: (command_name) @fn argument: (_) @spec)";
const CALL_FNS: ReadonlySet<string> = new Set(["source", "."]);

export function resolveBashSpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  const literal = firstQuoted(specifier) ?? stripQuotes(specifier);
  if (!literal) return { kind: "unresolved", reason: "dynamic" };
  if (literal.includes("$")) return { kind: "unresolved", reason: "dynamic" };
  // PATH lookup: bare command names are runtime decisions.
  if (!literal.includes("/") && !literal.endsWith(".sh")) return { kind: "unresolved", reason: "dynamic" };

  const candidates = [posix.normalize(posix.join(posix.dirname(fromFile), literal)), posix.normalize(literal)];
  for (const candidate of candidates) {
    if (context.fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
  }
  return { kind: "unresolved", reason: "no-source" };
}

export function registerBash(): void {
  const support: LanguageSupport = {
    id: "bash",
    extensions: [".sh", ".bash"],
    grammar: "bash",
    importQuery: QUERY,
    callFns: CALL_FNS,
    resolve: resolveBashSpecifier,
  };
  registerLanguage(support);
}
