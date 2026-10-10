import { dirname, posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";
import { fileIndexFor } from "./file-index.js";

/**
 * Go. Import specifiers are module paths; mapping them to directories needs
 * go.mod's module path. A repo-external import is external; a go.mod that is
 * missing or lacks the module line is needs-config. Resolution lands on the
 * directory holding the imported package, expanded to all its .go files.
 */

const QUERY = "(import_spec path: (interpreted_string_literal) @spec)";

function filesInDirectory(fileSet: ReadonlySet<string>, directory: string): readonly string[] {
  return fileIndexFor(fileSet).containedIn(directory, ".go");
}

export function resolveGoSpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = posix.normalize(posix.join(dirname(fromFile), specifier));
    const files = filesInDirectory(context.fileSet, target);
    return files.length ? { kind: "resolved", paths: files } : { kind: "unresolved", reason: "no-source" };
  }
  const modulePath = context.config.goModulePath;
  if (!modulePath) return { kind: "unresolved", reason: "needs-config" };
  let directory: string | undefined;
  if (specifier === modulePath) directory = ".";
  else if (specifier.startsWith(`${modulePath}/`)) directory = specifier.slice(modulePath.length + 1);
  if (directory === undefined) return { kind: "unresolved", reason: "external" };
  const files = filesInDirectory(context.fileSet, directory);
  return files.length ? { kind: "resolved", paths: files } : { kind: "unresolved", reason: "no-source" };
}

export function registerGo(): void {
  const support: LanguageSupport = {
    id: "go",
    extensions: [".go"],
    grammar: "go",
    importQuery: QUERY,
    resolve: resolveGoSpecifier,
  };
  registerLanguage(support);
}
