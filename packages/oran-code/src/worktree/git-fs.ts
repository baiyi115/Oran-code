/**
 * Pure filesystem reads of Git state (F7-F11, N4).
 * This module never spawns a git subprocess; every failure returns the empty value the spec
 * calls for.
 */
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isSafeRefName } from "./safety.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface WorktreeHead {
  readonly commit: string;
  readonly branch: string | undefined;
}

export interface ParsedHead {
  readonly kind: "ref" | "sha";
  readonly ref?: string;
  readonly sha?: string;
}

/** F7: resolve the location of the git directory from the repo root. Returns undefined when absent or unparseable. */
export async function resolveGitDir(repoRoot: string): Promise<string | undefined> {
  const marker = resolve(repoRoot, ".git");
  let stats;
  try {
    stats = await lstat(marker);
  } catch {
    return undefined;
  }
  if (stats.isDirectory()) return marker;
  if (!stats.isFile()) return undefined;
  let content: string;
  try {
    content = await readFile(marker, "utf8");
  } catch {
    return undefined;
  }
  const line = content.split(/\r?\n/, 1)[0]?.trim();
  if (!line?.startsWith("gitdir:")) return undefined;
  const raw = line.slice("gitdir:".length).trim();
  if (!raw) return undefined;
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
}

/** A worktree's git directory points at the shared git directory via commondir; if absent, use itself. */
export async function resolveCommondir(gitDir: string): Promise<string> {
  try {
    const content = (await readFile(resolve(gitDir, "commondir"), "utf8")).trim();
    if (!content) return gitDir;
    return isAbsolute(content) ? content : resolve(gitDir, content);
  } catch {
    return gitDir;
  }
}

/** F10: parse the contents of the HEAD file. */
export function parseHeadFile(content: string): ParsedHead | undefined {
  const trimmed = content.trim();
  if (trimmed.startsWith("ref: ")) {
    const ref = trimmed.slice("ref: ".length).trim();
    if (!ref) return undefined;
    return { kind: "ref", ref };
  }
  if (SHA_PATTERN.test(trimmed)) return { kind: "sha", sha: trimmed.toLowerCase() };
  return undefined;
}

/** F8/F9: read the worktree HEAD's commit and branch directly from the filesystem. */
export async function readWorktreeHead(repoRoot: string): Promise<WorktreeHead> {
  try {
    const gitDir = await resolveGitDir(repoRoot);
    if (!gitDir) return { commit: "", branch: undefined };
    const commonDir = await resolveCommondir(gitDir);
    let headContent: string;
    try {
      headContent = await readFile(resolve(gitDir, "HEAD"), "utf8");
    } catch {
      return { commit: "", branch: undefined };
    }
    const parsed = parseHeadFile(headContent);
    if (!parsed) return { commit: "", branch: undefined };
    if (parsed.kind === "sha") return { commit: parsed.sha ?? "", branch: undefined };

    const ref = parsed.ref ?? "";
    if (!isSafeRefName(ref)) return { commit: "", branch: undefined };
    const branch =
      ref.startsWith("refs/heads/") && isSafeRefName(ref.slice("refs/heads/".length))
        ? ref.slice("refs/heads/".length)
        : undefined;
    const commit = await resolveRef(ref, gitDir, commonDir);
    return { commit, branch };
  } catch {
    return { commit: "", branch: undefined };
  }
}

/** F11: ref resolution — loose refs first, then packed-refs, and finally a commondir fallback. */
export async function resolveRef(ref: string, gitDir: string, commonDir: string): Promise<string> {
  if (!isSafeRefName(ref)) return "";
  const candidates = [resolve(gitDir, ref), resolve(commonDir, ref)];
  for (const candidate of candidates) {
    const sha = await readLooseRef(candidate);
    if (sha) return sha;
  }
  for (const packedFile of [resolve(gitDir, "packed-refs"), resolve(commonDir, "packed-refs")]) {
    const sha = await readPackedRef(packedFile, ref);
    if (sha) return sha;
  }
  return "";
}

async function readLooseRef(filePath: string): Promise<string> {
  let content: string;
  try {
    content = (await readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
  if (SHA_PATTERN.test(content)) return content.toLowerCase();
  return "";
}

async function readPackedRef(filePath: string, ref: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return "";
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const sha = line.slice(0, space).trim();
    const name = line.slice(space + 1).trim();
    if (name === ref && SHA_PATTERN.test(sha)) return sha.toLowerCase();
  }
  return "";
}
