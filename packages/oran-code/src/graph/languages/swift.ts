import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { fileIndexFor } from "./file-index.js";

/**
 * Swift. `import X` names a module, not a file; without an Xcode/SwiftPM
 * manifest we only recognize a same-named top-level directory of swift files
 * as the module's sources. Everything else is external.
 */

const QUERY = "(import_declaration (identifier) @spec)";

function resolve(specifier: string, context: ResolveContext): ResolveResult {
  if (!specifier) return { kind: "unresolved", reason: "dynamic" };
  const prefix = `${specifier}/`;
  const files = fileIndexFor(context.fileSet).withPrefix(prefix, ".swift");
  if (files.length > 0) return { kind: "resolved", paths: files };
  return { kind: "unresolved", reason: "external" };
}

export function registerSwift(): void {
  const support: LanguageSupport = {
    id: "swift",
    extensions: [".swift"],
    grammar: "swift",
    importQuery: QUERY,
    resolve: (_fromFile, specifier, context) => resolve(specifier, context),
  };
  registerLanguage(support);
}
