import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Unified implementation of path-containment checks.
 *
 * - `isWithinPath` / `comparablePath`: case policy follows the platform (folded on win32,
 *   case-sensitive on posix), for scenarios such as permission sandboxes where cross-platform
 *   semantics must agree;
 * - `isRelativeWithin` / `resolveWithinRoot`: purely lexical checks that neither fold case nor
 *   resolve symlinks, for fast containment validation between absolute paths on the same drive;
 * - `resolvePhysicalPath`: walks up to the nearest existing ancestor, realpaths it, then re-appends
 *   the nonexistent tail to get the physical path with symlinks resolved.
 */

export function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithinPath(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root);
  const normalizedCandidate = comparablePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export function isRelativeWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../"));
}

/**
 * Resolve the input to an absolute path inside root, throwing on escape; label names the value in
 * the error message.
 */
export function resolveWithinRoot(root: string, raw: string, label = "path"): string {
  const candidate = resolve(root, raw);
  if (!isRelativeWithin(root, candidate)) {
    throw new Error(`${label} escapes workspace: ${raw}`);
  }
  return candidate;
}

/**
 * When input is absolute, base is ignored; when it is relative, it resolves against base.
 * A failed resolution (a stat error other than ENOENT, for example) returns undefined.
 */
export async function resolvePhysicalPath(input: string, base?: string): Promise<string | undefined> {
  const absolute = resolve(base ?? ".", input);
  let cursor = absolute;
  const tail: string[] = [];
  while (true) {
    try {
      await lstat(cursor);
      const physical = await realpath(cursor);
      return resolve(physical, ...tail.reverse());
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      tail.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}
