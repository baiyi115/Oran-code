/**
 * Worktree 生命周期（F3-F6、F13-F17、N2/N4）。
 * 纯文件系统读取之外的动作允许启动 git 子进程。
 */
import { execFile } from "node:child_process";
import { copyFile, cp, lstat, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { readWorktreeHead } from "./git-fs.js";
import { isValidSlug, resolveWithinRoot, slugRuleDescription } from "./safety.js";
import { isRelativeWithin } from "../utils/path-containment.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly repoRoot: string;
}

export interface CleanupStep {
  readonly name: "remove-worktree" | "delete-branch";
  readonly ok: boolean;
  readonly error?: string;
}

export interface CleanupResult {
  readonly ok: boolean;
  readonly steps: readonly CleanupStep[];
}

export interface EnsureWorktreeResult {
  readonly info: WorktreeInfo;
  readonly warnings: readonly string[];
}

/** G4：Worktree 落盘目录统一为仓库内不被追踪的 .oran/worktrees/<slug>。 */
export function worktreeDirectory(repoRoot: string, slug: string): string {
  assertValidSlug(slug);
  return resolve(repoRoot, ".oran", "worktrees", slug);
}

/** G4：分支名固定 worktree-<slug>。 */
export function worktreeBranch(slug: string): string {
  assertValidSlug(slug);
  return `worktree-${slug}`;
}

/** F3：解析当前所在的 git 仓库根。 */
export async function resolveRepoRoot(workspace: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", workspace, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const root = result.stdout.trim();
  if (!root) throw new Error("not inside a git repository");
  return resolve(root);
}

/** F3：按 slug 创建 Worktree（含快速恢复）。 */
export async function ensureWorktree(workspace: string, slug: string): Promise<EnsureWorktreeResult> {
  const repoRoot = await resolveRepoRoot(workspace);
  const path = worktreeDirectory(repoRoot, slug);
  const branch = worktreeBranch(slug);

  let head: string;
  let warnings: readonly string[] = [];
  if (await exists(path)) {
    // 快速恢复必须证明目录属于当前仓库，避免把任意同名目录当成隔离工作区。
    if (!(await isRegisteredWorktree(repoRoot, path, branch))) {
      throw new Error(`existing worktree path is not registered for branch ${branch}: ${path}`);
    }
    head = await readHead(path);
    if (!head) throw new Error(`could not resolve existing worktree HEAD: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-B", branch, path, "HEAD"]);
    warnings = await initializeWorktree(repoRoot, path);
    head = await readHead(path);
  }

  return { info: { path, branch, head, repoRoot }, warnings };
}

/** F4：清理 Worktree——两步独立容错，任一抛错不传递给调用方。 */
export async function cleanupWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<CleanupResult> {
  const steps: CleanupStep[] = [];
  const removeResult = await tolerate(() => runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]));
  steps.push({
    name: "remove-worktree",
    ok: removeResult.ok,
    ...(removeResult.error ? { error: removeResult.error } : {}),
  });
  const branchResult = await tolerate(() => runGit(repoRoot, ["branch", "-D", "--", branch]));
  steps.push({
    name: "delete-branch",
    ok: branchResult.ok,
    ...(branchResult.error ? { error: branchResult.error } : {}),
  });
  return { ok: steps.every((step) => step.ok), steps };
}

/** F5：变更检测——fail-closed。 */
export async function hasChanges(worktreePath: string, baseline: string): Promise<boolean> {
  try {
    const status = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (status.stdout.trim()) return true;
    const head = await readWorktreeHead(worktreePath);
    if (!head.commit) throw new Error("could not read worktree HEAD");
    return head.commit !== baseline.trim().toLowerCase();
  } catch {
    return true;
  }
}

/** F6：可拼接到 prompt 的 Worktree 提示文本。 */
export function worktreePromptText(worktreePath: string, repoRoot: string): string {
  return [
    "You are working inside an isolated Git worktree.",
    `Worktree path: ${worktreePath}`,
    `Parent repository: ${repoRoot}`,
    "All changes you make here stay inside this worktree and are isolated from the parent working directory.",
  ].join("\n");
}

/**
 * F13-F17：创建后初始化，best-effort。
 * 每个子步骤独立容错，单步失败只记录警告，不影响后续步骤与创建主路径（N2）。
 */
export async function initializeWorktree(repoRoot: string, worktreePath: string): Promise<readonly string[]> {
  const warnings: string[] = [];
  await bestEffort(warnings, "copy project config", () => copyProjectConfigDirectory(repoRoot, worktreePath));
  await bestEffort(warnings, "configure hooks path", () => configureHooksPath(repoRoot, worktreePath));
  await bestEffort(warnings, "link large dependency directories", () =>
    linkLargeDependencyDirectories(repoRoot, worktreePath),
  );
  await bestEffort(warnings, "copy .worktreeinclude entries", () => copyWorktreeIncludeEntries(repoRoot, worktreePath));
  return warnings;
}

// ---------------------------------------------------------------- 初始化子步骤

/** F14：按白名单复制项目级 orancode 配置目录，跳过运行时数据。 */
async function copyProjectConfigDirectory(repoRoot: string, worktreePath: string): Promise<void> {
  const sourceRoot = resolve(repoRoot, ".oran");
  const targetRoot = resolve(worktreePath, ".oran");
  if (!(await exists(sourceRoot))) return;
  const entries = await readdirSafe(sourceRoot);
  for (const entry of entries) {
    if (!isConfigEntry(entry.name)) continue;
    const source = resolve(sourceRoot, entry.name);
    const target = resolve(targetRoot, entry.name);
    const info = await lstat(source);
    if (info.isDirectory()) {
      if (!(await exists(target))) await cp(source, target, { recursive: true, force: false });
    } else if (info.isFile()) {
      await mkdir(targetRoot, { recursive: true });
      if (!(await exists(target))) await copyFile(source, target);
    }
  }
}

const CONFIG_DIRECTORY_WHITELIST = new Set(["agents", "commands", "skills", "config", "hooks"]);
const CONFIG_FILE_WHITELIST = new Set(["config.json", "hooks.yaml", "hooks.local.yaml", "permissions.local.yaml"]);

function isConfigEntry(name: string): boolean {
  if (CONFIG_DIRECTORY_WHITELIST.has(name)) return true;
  if (CONFIG_FILE_WHITELIST.has(name)) return true;
  return name.startsWith("AGENTS") || name.startsWith("INSTRUCTIONS");
}

/** F15：配置 Worktree 内 hooks 路径——项目 hooks 优先，回退默认 hooks。 */
async function configureHooksPath(repoRoot: string, worktreePath: string): Promise<void> {
  const candidates = [resolve(repoRoot, ".oran", "hooks"), resolve(repoRoot, ".git", "hooks")];
  let hooksPath: string | undefined;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      hooksPath = candidate;
      break;
    }
  }
  if (!hooksPath) return;
  try {
    await runGit(worktreePath, ["config", "--worktree", "core.hooksPath", hooksPath]);
  } catch {
    // 旧仓库未启用 worktree config 时先开启扩展再重试。
    await runGit(repoRoot, ["config", "extensions.worktreeConfig", "true"]);
    await runGit(worktreePath, ["config", "--worktree", "core.hooksPath", hooksPath]);
  }
}

/** F16：软链大型依赖目录（当前约定根目录 node_modules）。 */
async function linkLargeDependencyDirectories(repoRoot: string, worktreePath: string): Promise<void> {
  const source = resolve(repoRoot, "node_modules");
  const target = resolve(worktreePath, "node_modules");
  if (!(await exists(source))) return;
  if (await exists(target)) return;
  if (process.platform === "win32") {
    await symlink(source, target, "junction");
  } else {
    await symlink(source, target, "dir");
  }
}

/** F17：按 .worktreeinclude 逐行复制被忽略但运行需要的文件或目录。 */
async function copyWorktreeIncludeEntries(repoRoot: string, worktreePath: string): Promise<void> {
  const listPath = resolve(repoRoot, ".worktreeinclude");
  let content: string;
  try {
    content = await readFile(listPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.split(/[\\/]+/).includes("..")) continue;
    if (isAbsolute(line)) continue;
    let source: string;
    let target: string;
    try {
      source = resolveWithinRoot(repoRoot, line, ".worktreeinclude source");
      target = resolveWithinRoot(worktreePath, line, ".worktreeinclude target");
    } catch {
      continue;
    }
    if (source === target || !(await exists(source))) continue;
    await mkdir(dirname(target), { recursive: true });
    const info = await lstat(source);
    if (info.isDirectory()) {
      // Avoid recursively copying a directory into its own descendant (for example an entry of ".").
      if (isRelativeWithin(source, target)) continue;
      if (!(await exists(target))) await cp(source, target, { recursive: true, force: false });
    } else if (info.isFile()) {
      if (!(await exists(target))) await copyFile(source, target);
    }
  }
}

// ---------------------------------------------------------------- 内部工具

function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) throw new Error(`invalid worktree slug: ${slug || "(empty)"}. ${slugRuleDescription()}`);
}

async function bestEffort(warnings: string[], label: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    warnings.push(`worktree init: ${label} failed: ${errorMessage(error)}`);
  }
}

async function readHead(worktreePath: string): Promise<string> {
  const fsHead = await readWorktreeHead(worktreePath);
  if (fsHead.commit) return fsHead.commit;
  try {
    const result = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function isRegisteredWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<boolean> {
  try {
    const result = await execFileAsync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    let currentPath: string | undefined;
    let currentBranch: string | undefined;
    const flush = (): boolean => {
      const matchesPath = currentPath !== undefined && sameWorktreePath(currentPath, worktreePath);
      const matchesBranch = currentBranch === `refs/heads/${branch}`;
      return matchesPath && matchesBranch;
    };
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        if (flush()) return true;
        currentPath = undefined;
        currentBranch = undefined;
        continue;
      }
      if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) currentBranch = line.slice("branch ".length).trim();
    }
    return flush();
  } catch {
    return false;
  }
}

function sameWorktreePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    let path = resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
    if (process.platform === "win32") path = path.toLowerCase();
    return path;
  };
  return normalize(left) === normalize(right);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

async function tolerate(task: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  try {
    await task();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readdirSafe(directory: string): Promise<readonly { readonly name: string }[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
