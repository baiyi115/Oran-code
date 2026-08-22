import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 路径包含判断的统一实现。
 *
 * - `isWithinPath` / `comparablePath`:大小写策略随平台(win32 折叠、posix 敏感),
 *   用于权限沙箱等跨平台语义必须一致的场景;
 * - `isRelativeWithin` / `resolveWithinRoot`:纯词法判断,不折叠大小写、不解析
 *   symlink,用于同盘绝对路径之间的快速包含校验;
 * - `resolvePhysicalPath`:向上寻找最近存在的祖先做 realpath 后拼回不存在的
 *   尾部,得到 symlink 解析后的物理路径。
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

/** 把输入解析为 root 之内的绝对路径,逃逸即抛错;label 用于错误信息。 */
export function resolveWithinRoot(root: string, raw: string, label = "path"): string {
  const candidate = resolve(root, raw);
  if (!isRelativeWithin(root, candidate)) {
    throw new Error(`${label} escapes workspace: ${raw}`);
  }
  return candidate;
}

/**
 * input 为绝对路径时 base 被忽略;为相对路径时相对 base 解析。
 * 解析失败(非 ENOENT 的 stat 错误等)返回 undefined。
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
