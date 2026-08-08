/**
 * Worktree 安全校验：slug 与 ref 名称校验集中实现（N5）。
 * 任何不安全输入立即判为无效，绝不参与后续路径拼接或子进程命令构造。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 工具级 slug 长度上限（技术需求：限字符集和长度）。 */
export const SLUG_MAX_LENGTH = 64;

const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

/** F1：slug 只允许字母、数字、连字符、下划线，拒绝路径分隔符与点号。 */
export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/** F1：输出 slug 字符集要求，供错误信息拼接。 */
export function slugRuleDescription(): string {
  return `slug must be 1-${SLUG_MAX_LENGTH} characters using only A-Z, a-z, 0-9, "-" and "_"`;
}

const SAFE_REF_CHARS = /^[A-Za-z0-9._/-]+$/;
const MAX_REF_LENGTH = 1024;

/** F12：ref 名称安全校验。 */
export function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > MAX_REF_LENGTH) return false;
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (!SAFE_REF_CHARS.test(ref)) return false;
  for (const segment of ref.split("/")) {
    if (!segment || segment === "." || segment === "..") return false;
  }
  return true;
}

/** refs/heads/<name> 下的短分支名校验。 */
export function isSafeBranchName(branch: string): boolean {
  if (isSafeRefName(branch) && branch.startsWith("refs/heads/")) {
    return isSafeRefName(branch.slice("refs/heads/".length));
  }
  return isSafeRefName(branch);
}

/** 解析到短分支名；带 refs/heads/ 前缀时去掉前缀。 */
export function shortBranchName(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

/**
 * 把用户输入解析为 root 之内的绝对路径。
 * 绝对路径输入同样参与相对性校验，逃逸即抛错。
 */
export function resolveWithinRoot(root: string, raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} must be a non-empty path`);
  const candidate = resolve(root, raw);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${label} escapes workspace: ${raw}`);
  }
  return candidate;
}
