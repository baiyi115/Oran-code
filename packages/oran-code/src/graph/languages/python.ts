import { posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveResult } from "./registry.js";
import { fileIndexFor } from "./file-index.js";

/**
 * Python. Two specifier shapes reach resolve():
 * - dotted module names ("a.b.c" for absolute, ".x"/"..pkg.x" for relative)
 * - a bare relative prefix (".") for `from . import x`, which resolves to the
 *   package's __init__.py — the file-level approximation of that import.
 *
 * Absolute imports are tried against every ancestor directory of the importing
 * file (plus the workspace root); a miss whose top-level name exists somewhere
 * in the repo is no-source, otherwise external.
 */

const QUERY = [
  "(import_statement name: (dotted_name) @spec)",
  "(import_from_statement module_name: (dotted_name) @spec)",
  "(import_from_statement module_name: (relative_import) @spec)",
].join("\n");

function packageCandidates(baseDir: string, modulePath: string): string[] {
  const file = `${baseDir === "." ? "" : `${baseDir}/`}${modulePath.replaceAll(".", "/")}.py`;
  const init = `${baseDir === "." ? "" : `${baseDir}/`}${modulePath.replaceAll(".", "/")}/__init__.py`;
  return [file, init];
}

function resolveRelative(fromFile: string, specifier: string, fileSet: ReadonlySet<string>): ResolveResult {
  const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
  const name = specifier.slice(dots);
  // dots=1 means the current package, i.e. the directory containing the file.
  let baseDir = posix.dirname(fromFile);
  for (let up = 1; up < dots; up += 1) baseDir = posix.dirname(baseDir);
  const modulePath = name || "__init__";
  for (const candidate of packageCandidates(baseDir, modulePath)) {
    if (fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
  }
  return { kind: "unresolved", reason: "no-source" };
}

export function resolvePythonSpecifier(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): ResolveResult {
  if (specifier.startsWith(".")) return resolveRelative(fromFile, specifier, fileSet);

  // Try the importing file's ancestor directories, nearest first, then the root.
  const segments = fromFile.split("/");
  const dirs: string[] = [];
  for (let count = segments.length - 1; count >= 1; count -= 1) {
    dirs.push(segments.slice(0, count).join("/"));
  }
  dirs.push(".");
  for (const dir of dirs) {
    for (const candidate of packageCandidates(dir, specifier)) {
      if (fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
    }
  }
  // Distinguish "repo has this top-level name but not this module" (a gap)
  // from "some installed package" (by design out of scope).
  const top = `${specifier.split(".")[0]}/`;
  if (fileIndexFor(fileSet).hasPrefix(top)) return { kind: "unresolved", reason: "no-source" };
  return { kind: "unresolved", reason: "external" };
}

export function registerPython(): void {
  const support: LanguageSupport = {
    id: "python",
    extensions: [".py"],
    grammar: "python",
    importQuery: QUERY,
    symbols: {
      defs: [
        "(function_definition name: (identifier) @name) @def",
        "(class_definition name: (identifier) @name) @def",
        // Same rule as the TypeScript family: a function bound to a name is a
        // symbol, so `handler = lambda ...` can be a call target. Rare next to
        // `def`, but its absence was silent, which is the part that matters.
        "(assignment left: (identifier) @name right: (lambda)) @def",
      ].join("\n"),
      defKinds: ["function", "class", "function"],
      calls: "(call function: (identifier) @callee)",
      bindings: [
        "(import_from_statement module_name: (dotted_name) @src name: (dotted_name) @bind)",
        "(import_from_statement module_name: (relative_import) @src name: (dotted_name) @bind)",
      ].join("\n"),
      inherit: "(class_definition name: (identifier) @class (argument_list (identifier) @super))",
    },
    resolve: (fromFile, specifier, context) => resolvePythonSpecifier(fromFile, specifier, context.fileSet),
  };
  registerLanguage(support);
}
