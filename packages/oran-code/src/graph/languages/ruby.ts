import { posix } from "node:path";
import { stripQuotes } from "../extract.js";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";

/**
 * Ruby. `require_relative` resolves against the file's own directory, with or
 * without a leading "./" — the bare form is the ordinary way it is written, so
 * those specifiers are normalised into the relative form here. Plain `require`
 * goes through the load path, which we do not model; a unique repo-wide suffix
 * match is the only honest resolution, anything else is external.
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
    specFromMatch: (captures) => {
      const fn = captures.get("fn");
      const raw = captures.get("spec");
      if (raw === undefined || fn === undefined || !CALL_FNS.has(fn)) return [];
      // The capture covers the string node, quotes included; the default
      // extraction path strips them for the languages that do not come through
      // here, so this one has to as well.
      const spec = stripQuotes(raw);
      // A bare `require_relative "x"` used to fall through to the repo-wide
      // suffix match, which resolved it to an unrelated file with the same
      // basename and reported a confident edge to it. Marking it relative sends
      // it to the exact, file-adjacent branch above.
      if (fn === "require_relative") return [spec.startsWith(".") ? spec : `./${spec}`];
      return [spec];
    },
    resolve: resolveRubySpecifier,
  };
  registerLanguage(support);
}
