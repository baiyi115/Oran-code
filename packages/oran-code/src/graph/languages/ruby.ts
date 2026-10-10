import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";

/**
 * Ruby. require_relative is exact (file dir + .rb); plain require goes through
 * the load path, which we do not model — a unique repo-wide suffix match is
 * the only honest resolution, anything else is external.
 */

const QUERY = "(call method: (identifier) @fn arguments: (argument_list (string (string_content)) @spec))";
const CALL_FNS: ReadonlySet<string> = new Set(["require", "require_relative"]);

function uniqueSuffixMatch(fileSet: ReadonlySet<string>, suffix: string): ResolveResult | undefined {
  const matches = [...fileSet].filter((file) => file === suffix || file.endsWith(`/${suffix}`)).sort();
  if (matches.length === 1) return { kind: "resolved", paths: matches };
  if (matches.length > 1) return { kind: "unresolved", reason: "ambiguous" };
  return undefined;
}

export function resolveRubySpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  if (!specifier) return { kind: "unresolved", reason: "dynamic" };
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    for (const candidate of [target, `${target}.rb`]) {
      if (context.fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
    }
    return { kind: "unresolved", reason: "no-source" };
  }
  return uniqueSuffixMatch(context.fileSet, `${specifier}.rb`) ?? { kind: "unresolved", reason: "external" };
}

export function registerRuby(): void {
  const support: LanguageSupport = {
    id: "ruby",
    extensions: [".rb"],
    grammar: "ruby",
    importQuery: QUERY,
    callFns: CALL_FNS,
    resolve: resolveRubySpecifier,
  };
  registerLanguage(support);
}
