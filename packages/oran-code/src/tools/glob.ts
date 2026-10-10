import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
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

export async function walkFiles(
  directory: string,
  visit: (filePath: string, mtime: number) => Promise<void>,
  onFailure?: (failure: WalkFailure) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await retryOnce(() => readdir(directory, { withFileTypes: true }));
  } catch (error) {
    // Bailing out is right for the walker, but the caller has to know: without
    // the report the whole subtree is missing from whatever it is building.
    onFailure?.({ path: directory, error: errorText(error) });
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, visit, onFailure);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await retryOnce(() => stat(fullPath));
      await visit(fullPath, info.mtimeMs);
    } catch (error) {
      onFailure?.({ path: fullPath, error: errorText(error) });
    }
  }
}
