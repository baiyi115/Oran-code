import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveResult } from "./registry.js";

/**
 * C / C++. Quoted includes resolve against the including file's directory;
 * anything else needs include-path configuration that we do not parse, so it
 * is reported as needs-config rather than guessed. Angle-bracket includes
 * (system headers) are external by design.
 */

const QUERY = "(preproc_include path: (_) @spec)";

function makeSupport(id: LanguageSupport["id"], extensions: string[], grammar: string): LanguageSupport {
  return {
    id,
    extensions,
    grammar,
    importQuery: QUERY,
    resolve: (fromFile, specifier, context): ResolveResult => {
      if (specifier.startsWith("<")) return { kind: "unresolved", reason: "external" };
      const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
      if (context.fileSet.has(target)) return { kind: "resolved", paths: [target] };
      return { kind: "unresolved", reason: "needs-config" };
    },
  };
}

export function registerCFamily(): void {
  registerLanguage(makeSupport("c", [".c"], "c"));
  registerLanguage(makeSupport("cpp", [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".h", ".hxx"], "cpp"));
}
