import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { firstQuoted } from "../extract.js";

/**
 * Lua. require("a.b") maps to a/b.lua or a/b/init.lua; relative specifiers
 * resolve against the requiring file. Unknown module names are usually rocks
 * (installed packages), so they stay external.
 */

const QUERY = "(call function: (variable name: (identifier) @fn) arguments: (argument_list (_) @spec))";
const CALL_FNS: ReadonlySet<string> = new Set(["require"]);

export function resolveLuaSpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  if (!specifier) return { kind: "unresolved", reason: "dynamic" };

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    for (const candidate of [target, `${target}.lua`]) {
      if (context.fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
    }
    return { kind: "unresolved", reason: "no-source" };
  }

  const dotted = specifier.replaceAll(".", "/");
  for (const base of [dotted, `${dotted}/init`]) {
    for (const candidate of [base, `${base}.lua`]) {
      if (context.fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
    }
  }
  return { kind: "unresolved", reason: "external" };
}

export function registerLua(): void {
  const support: LanguageSupport = {
    id: "lua",
    extensions: [".lua"],
    grammar: "lua",
    importQuery: QUERY,
    callFns: CALL_FNS,
    specFromMatch: (captures) => {
      if (captures.get("fn") !== "require") return [];
      const literal = firstQuoted(captures.get("spec") ?? "");
      return literal ? [literal] : [];
    },
    resolve: resolveLuaSpecifier,
  };
  registerLanguage(support);
}
