import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { compileGlob, walkFiles } from "./glob.js";

/**
 * One search, reduced to plain data so it can run either in this thread or in the
 * search host (see search-service.ts). The path fields are absolute: the scan is
 * told what to walk, not how the tool resolved it.
 */
export interface SearchRequest {
  /** Workspace root; hit paths are reported relative to it. */
  root: string;
  /** Directory the walk starts from. */
  base: string;
  /** JavaScript regular-expression source, exactly as the model wrote it. */
  pattern: string;
  /** Optional file-name glob filter. */
  glob?: string | undefined;
  limit: number;
  /** Soft budget: the scan gives up between lines once it is exceeded. */
  budgetMs: number;
}

export interface SearchOutcome {
  hits: string[];
  /** Matches found, including the ones past `limit` that are only counted. */
  total: number;
  /** Paths the walk could not read, so the caller can say the result is partial. */
  unreadable: string[];
  /** The soft budget was reached; `hits` holds what was found until then. */
  timedOut: boolean;
}

/**
 * Only the first 4096 characters of a line are matched.
 *
 * This is a bound on work, not a defence against backtracking: catastrophic
 * patterns only need tens of characters. It matters because the budget below is
 * checked between lines and cannot interrupt a single `test` call.
 */
export const SEARCH_MAX_LINE_LENGTH = 4_096;

/** Walk, read and match. `onHit` is called as hits are found, so a caller that later kills the scan still has them. */
export async function runSearch(request: SearchRequest, onHit?: (hit: string) => void): Promise<SearchOutcome> {
  const regex = new RegExp(request.pattern);
  const fileFilter = request.glob?.trim() ? compileGlob(request.glob) : undefined;
  const hits: string[] = [];
  const unreadable: string[] = [];
  let total = 0;
  let timedOut = false;
  const startedAt = Date.now();

  await walkFiles(
    request.base,
    async (filePath) => {
      if (hits.length >= request.limit || timedOut) return;
      const rel = relative(request.root, filePath).replaceAll("\\", "/");
      const name = rel.split("/").pop() ?? rel;
      if (fileFilter && !fileFilter(rel) && !fileFilter(name)) return;
      let lines: string[];
      try {
        lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
      } catch {
        // Binary or unreadable file: not a search result.
        return;
      }
      for (let index = 0; index < lines.length; index += 1) {
        if ((index & 0xff) === 0 && Date.now() - startedAt > request.budgetMs) {
          timedOut = true;
          return;
        }
        const line = lines[index] ?? "";
        regex.lastIndex = 0;
        const subject = line.length > SEARCH_MAX_LINE_LENGTH ? line.slice(0, SEARCH_MAX_LINE_LENGTH) : line;
        if (!regex.test(subject)) continue;
        total += 1;
        if (hits.length < request.limit) {
          const hit = `${rel}:${index + 1}:${line.trim().slice(0, 200)}`;
          hits.push(hit);
          onHit?.(hit);
        }
      }
    },
    (failure) => unreadable.push(relative(request.root, failure.path).replaceAll("\\", "/") || failure.path),
  );

  return { hits, total, unreadable, timedOut };
}
