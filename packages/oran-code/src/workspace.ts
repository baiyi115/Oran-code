import { execFile } from "node:child_process";
import { opendir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSnapshot } from "./types.js";

const IGNORED_DIRS = new Set([".git", ".venv", "venv", "__pycache__", "node_modules", "dist", "build"]);
const PROJECT_FILES = new Set(["README.md", "README", "AGENTS.md", "CLAUDE.md", "pyproject.toml", "package.json", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "tsconfig.json"]);
const WORKSPACE_SCAN_BUDGET_MS = 750;
const GIT_STATUS_TIMEOUT_MS = 750;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_TOP_LEVEL_ENTRIES = 200;
const execFileAsync = promisify(execFile);

interface ScanState {
  readonly root: string;
  readonly maxDepth: number;
  readonly deadline: number;
  readonly topLevel: Array<{ name: string; isDirectory: boolean }>;
  readonly projectFiles: Record<string, string>;
  readonly recent: Array<{ mtime: number; path: string }>;
  visited: number;
  truncated: boolean;
}

interface GitMetadata {
  isGitRepo: boolean;
  branch?: string;
  dirty?: boolean;
}

export async function discoverWorkspace(rootPath: string, maxDepth = 4): Promise<WorkspaceSnapshot> {
  const root = resolve(rootPath);
  const scan: ScanState = {
    root,
    maxDepth,
    deadline: Date.now() + WORKSPACE_SCAN_BUDGET_MS,
    topLevel: [],
    projectFiles: {},
    recent: [],
    visited: 0,
    truncated: false,
  };
  const [, git] = await Promise.all([
    visit(root, 0, scan),
    readGitMetadata(root),
  ]);
  scan.topLevel.sort((left, right) => Number(!left.isDirectory) - Number(!right.isDirectory) || left.name.localeCompare(right.name));
  scan.recent.sort((left, right) => right.mtime - left.mtime);
  const recentFiles = scan.recent.slice(0, 20).map((item) => item.path);
  const snapshot = {
    root,
    projectFiles: scan.projectFiles,
    topLevel: scan.topLevel.map((entry) => entry.name),
    isGitRepo: git.isGitRepo,
    ...(git.branch ? { gitBranch: git.branch } : {}),
    ...(git.dirty !== undefined ? { gitDirty: git.dirty } : {}),
    ...(scan.truncated ? { scanTruncated: true } : {}),
    recentFiles,
  } satisfies Omit<WorkspaceSnapshot, "summary">;
  return { ...snapshot, summary: summarize(snapshot) };
}

function summarize(snapshot: Omit<WorkspaceSnapshot, "summary">): string {
  const lines = [`Workspace: ${snapshot.root}`];
  if (snapshot.isGitRepo) {
    lines.push("Git repository: yes");
    if (snapshot.gitBranch) lines.push(`Git branch: ${snapshot.gitBranch}`);
    if (snapshot.gitDirty !== undefined) lines.push(`Git working tree: ${snapshot.gitDirty ? "dirty" : "clean"}`);
  }
  if (snapshot.scanTruncated) lines.push("Workspace scan: truncated by the 750ms or 5000-entry limit");
  lines.push("Project files:");
  for (const [name, path] of Object.entries(snapshot.projectFiles)) lines.push(`- ${name}: ${path}`);
  lines.push("Top-level entries:");
  for (const entry of snapshot.topLevel) lines.push(`- ${entry}`);
  return lines.join("\n");
}

async function visit(directoryPath: string, depth: number, state: ScanState): Promise<void> {
  if (depth > state.maxDepth || !hasScanBudget(state)) return;
  try {
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      if (!hasScanBudget(state)) break;
      if (depth === 0 && state.topLevel.length >= MAX_TOP_LEVEL_ENTRIES) {
        state.truncated = true;
        break;
      }

      state.visited += 1;
      if (depth === 0) {
        // Skip ignored directories (.git/node_modules/dist) so they do not
        // pollute the workspace summary; dot-files like .gitignore are kept.
        if (!(entry.isDirectory() && IGNORED_DIRS.has(entry.name))) {
          state.topLevel.push({ name: entry.name, isDirectory: entry.isDirectory() });
        }
        if (entry.isFile() && PROJECT_FILES.has(entry.name)) state.projectFiles[entry.name] = entry.name;
      }
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolutePath = resolve(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1, state);
      } else if (entry.isFile()) {
        try {
          state.recent.push({ mtime: (await stat(absolutePath)).mtimeMs, path: absolutePath.slice(state.root.length + 1) });
        } catch {
          // Ignore unreadable entries while retaining the rest of the snapshot.
        }
      }
    }
  } catch {
    // An inaccessible directory contributes no snapshot entries.
  }
}

function hasScanBudget(state: ScanState): boolean {
  if (state.visited < MAX_SCAN_ENTRIES && Date.now() < state.deadline) return true;
  state.truncated = true;
  return false;
}

async function readGitMetadata(root: string): Promise<GitMetadata> {
  const markerExists = await exists(resolve(root, ".git"));
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v2", "--branch"],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout: GIT_STATUS_TIMEOUT_MS, windowsHide: true },
    );
    let branch: string | undefined;
    let dirty = false;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
      else if (line && !line.startsWith("# ")) dirty = true;
    }
    return { isGitRepo: true, ...(branch ? { branch } : {}), dirty };
  } catch {
    return { isGitRepo: markerExists };
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
