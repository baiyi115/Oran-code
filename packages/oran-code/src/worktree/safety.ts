/**
 * Worktree safety validation: slug and ref-name checks live in one place (N5).
 * Any unsafe input is invalidated immediately and never takes part in later path joins or
 * subprocess command construction.
 */
import { resolveWithinRoot as resolveWithin } from "../utils/path-containment.js";

/** Tool-level slug length limit (technical requirement: constrain the character set and the length). */
export const SLUG_MAX_LENGTH = 64;

const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

/** F1: a slug allows only letters, digits, hyphens and underscores; path separators and dots are rejected. */
export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/** F1: render the slug character-set requirement, for composing error messages. */
export function slugRuleDescription(): string {
  return `slug must be 1-${SLUG_MAX_LENGTH} characters using only A-Z, a-z, 0-9, "-" and "_"`;
}

const SAFE_REF_CHARS = /^[A-Za-z0-9._/-]+$/;
const MAX_REF_LENGTH = 1024;

/** F12: safe-ref-name validation. */
export function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > MAX_REF_LENGTH) return false;
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (!SAFE_REF_CHARS.test(ref)) return false;
  for (const segment of ref.split("/")) {
    if (!segment || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Validation for a short branch name under refs/heads/<name>. */
export function isSafeBranchName(branch: string): boolean {
  if (isSafeRefName(branch) && branch.startsWith("refs/heads/")) {
    return isSafeRefName(branch.slice("refs/heads/".length));
  }
  return isSafeRefName(branch);
}

/** Resolve to the short branch name; the refs/heads/ prefix is stripped when present. */
export function shortBranchName(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

/**
 * Resolve user input to an absolute path inside root.
 * Absolute inputs undergo the same containment check, and escaping throws.
 */
export function resolveWithinRoot(root: string, raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} must be a non-empty path`);
  return resolveWithin(root, raw, label);
}
