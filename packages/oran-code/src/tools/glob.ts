import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { PROJECT_STATE_DIR_NAMES } from "../paths.js";

export const IGNORED_DIRS = new Set([
  ...PROJECT_STATE_DIR_NAMES,
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

export function compileGlob(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  const regexes = expandBracePatterns(normalized).map((item) => new RegExp(`^${globSource(item)}$`, "i"));
  return (path: string) => {
    const candidate = path.replaceAll("\\", "/");
    return regexes.some((regex) => regex.test(candidate));
  };
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

function expandBracePatterns(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const alternatives = pattern
    .slice(open + 1, close)
    .split(",")
    .filter(Boolean);
  if (alternatives.length < 2) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  return alternatives
    .slice(0, 32)
    .flatMap((alternative) => expandBracePatterns(`${prefix}${alternative}${suffix}`))
    .slice(0, 32);
}

/** A path the walk could not read; callers decide whether to report or ignore it. */
export interface WalkFailure {
  path: string;
  error: string;
}

const WALK_RETRY_DELAY_MS = 20;

/**
 * Transient failures (EMFILE/EBUSY under load) are worth one retry: a directory
 * that cannot be listed loses its whole subtree, and a file that cannot be
 * stat'ed silently disappears from the results. Both used to happen without a
 * word, so a graph built from the walk could quietly be missing files.
 */
async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, WALK_RETRY_DELAY_MS));
    try {
      return await operation();
    } catch {
      throw first;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Walk state shared down the recursion: the root's physical path, and what was already walked. */
interface WalkState {
  rootReal: string;
  visited: Set<string>;
}

export async function walkFiles(
  directory: string,
  visit: (filePath: string, mtime: number) => Promise<void>,
  onFailure?: (failure: WalkFailure) => void,
  state?: WalkState,
): Promise<void> {
  const context = state ?? (await createWalkState(directory));
  const identity = await physicalPath(directory);
  // A symlinked directory is followed (a monorepo links `packages/shared` at
  // `../shared`), so the same physical directory can be reachable twice and a link
  // can point back up the tree: walking each identity once is what keeps this
  // bounded, and it also stops one file being reported under two paths.
  if (context.visited.has(identity)) return;
  context.visited.add(identity);

  let entries: Dirent[];
  try {
    entries = await retryOnce(() => readdir(directory, { withFileTypes: true }));
  } catch (error) {
    // Bailing out is right for the walker, but the caller has to know: without
    // the report the whole subtree is missing from whatever it is building.
    onFailure?.({ path: directory, error: errorText(error) });
    return;
  }
  const visitEntry = async (entryPath: string): Promise<void> => {
    try {
      const info = await retryOnce(() => stat(entryPath));
      await visit(entryPath, info.mtimeMs);
    } catch (error) {
      onFailure?.({ path: entryPath, error: errorText(error) });
    }
  };
  // Real entries first, links after: the first path to a physical directory is the
  // one everything downstream sees, and that has to be the real one. With a link
  // walked first, a file inside a linked directory was reported under the link path
  // only — the same tree seen through a different name.
  const ordered = [...entries].sort((left, right) => Number(left.isSymbolicLink()) - Number(right.isSymbolicLink()));
  for (const entry of ordered) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, visit, onFailure, context);
      continue;
    }
    if (entry.isFile()) {
      await visitEntry(fullPath);
      continue;
    }
    // readdir reports a symlink as neither a file nor a directory, so every
    // symlinked source file used to be skipped before it was ever stat'ed — and a
    // symlinked directory with it. Links are followed while they resolve inside the
    // walk root: a repository could otherwise make these tools read files outside
    // the workspace just by committing a link, which is a boundary the tools are
    // supposed to hold.
    if (!entry.isSymbolicLink()) continue;
    const target = await physicalPath(fullPath);
    if (!isInside(context.rootReal, target)) continue;
    let info;
    try {
      info = await retryOnce(() => stat(fullPath));
    } catch (error) {
      onFailure?.({ path: fullPath, error: errorText(error) });
      continue;
    }
    if (info.isDirectory()) await walkFiles(fullPath, visit, onFailure, context);
    else if (info.isFile()) await visitEntry(fullPath);
  }
}

async function createWalkState(root: string): Promise<WalkState> {
  return { rootReal: await physicalPath(root), visited: new Set<string>() };
}

/** The physical path, or the lexical one when it cannot be resolved. */
async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
