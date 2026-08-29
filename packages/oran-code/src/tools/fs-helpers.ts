import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";
import type { ToolResult } from "../types.js";
import { resolveWithinRoot } from "../utils/path-containment.js";

export function resolveWorkspacePath(root: string, raw: unknown): string {
  return resolveWithinRoot(root, typeof raw === "string" && raw.length ? raw : ".");
}

export function displayPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).replaceAll("\\", "/");
  return rel || ".";
}

export function intArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return fallback;
}

export function numberArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count += 1;
    start = index + needle.length;
  }
  return count;
}

export function failedResult(error: unknown, fallback: string): ToolResult {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") {
    return { ok: false, output: "", error: `path not found: ${errorMessage(error)}`, summary: "not found" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { ok: false, output: "", error: `permission denied: ${errorMessage(error)}`, summary: "permission denied" };
  }
  return { ok: false, output: "", error: errorMessage(error) || fallback, summary: "error" };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tempPath, content, "utf8");
    try {
      await rename(tempPath, path);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EEXIST") {
        await copyFile(tempPath, path);
        await unlink(tempPath).catch(() => {});
      } else {
        throw err;
      }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}
