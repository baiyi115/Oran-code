import { dirname, posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";

/**
 * Go. Import specifiers are module paths; mapping them to directories needs
 * go.mod's module path. A repo-external import is external; a go.mod that is
 * missing or lacks the module line is needs-config. Resolution lands on the
 * directory holding the imported package, expanded to all its .go files.
 */

const QUERY = "(import_spec path: (interpreted_string_literal) @spec)";

/** directory -> sorted .go files, cached per build's file set. */
const directoryIndexCache = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

function filesInDirectory(fileSet: ReadonlySet<string>, directory: string): string[] {
  let index = directoryIndexCache.get(fileSet);
  if (!index) {
    index = new Map<string, string[]>();
    directoryIndexCache.set(fileSet, index);
  }
  const cached = index.get(directory);
  if (cached) return cached;
  const prefix = directory === "." ? "" : `${directory}/`;
  const files: string[] = [];
  for (const file of fileSet) {
    if (!file.endsWith(".go")) continue;
    if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) files.push(file);
  }
  files.sort();
  index.set(directory, files);
  return files;
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
