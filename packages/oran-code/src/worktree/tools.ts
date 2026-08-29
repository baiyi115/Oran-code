/**
 * Worktree 工具：enter_worktree / exit_worktree（F1-F2、F18-F19）。
 * 两个工具均标记为按需暴露（deferred），初始工具清单不含它们（N1）。
 */
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import {
  cleanupWorktree,
  ensureWorktree,
  hasChanges,
  resolveRepoRoot,
  worktreeDirectory,
  worktreePromptText,
} from "./lifecycle.js";
import { isSafeBranchName, isValidSlug, shortBranchName, slugRuleDescription } from "./safety.js";

/** F18：注册两个按需暴露的 Worktree 工具。 */
export function registerWorktreeTools(
  registry: { register(tool: ToolDefinition): void },
  fallbackWorkspace: string,
): void {
  registry.register(enterWorktreeDefinition(fallbackWorkspace));
  registry.register(exitWorktreeDefinition(fallbackWorkspace));
}

/** F19：这两个工具默认不暴露，通过 search_tools 按关键词发现后解锁。 */
export const WORKTREE_TOOL_NAMES: readonly string[] = ["enter_worktree", "exit_worktree"];

function enterWorktreeDefinition(fallbackWorkspace: string): ToolDefinition {
  return {
    name: "enter_worktree",
    description:
      "Create or fast-recover an isolated Git worktree for parallel work. " +
      "Accepts a slug (letters, digits, hyphen, underscore only). The worktree is created under .oran/worktrees/<slug> " +
      "on branch worktree-<slug>, initialized with project config, hooks, and symlinked dependencies. " +
      "Use the returned absolute worktree path as the cwd/root for subsequent file tools.",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Worktree identifier. Only A-Z, a-z, 0-9, '-' and '_' are allowed.",
        },
      },
      required: ["slug"],
    },
    permissionLevel: 2,
    kind: "command",
    deferred: true,
    maxOutputChars: 16_000,
    invoke: async (call, context) => {
      const workspace = context?.workspace ?? fallbackWorkspace;
      const slug = String(call.arguments.slug ?? "").trim();
      if (!isValidSlug(slug)) {
        return {
          ok: false,
          output: "",
          error: `invalid slug: ${slug || "(empty)"}. ${slugRuleDescription()}`,
          summary: "invalid slug",
        };
      }
      try {
        const result = await ensureWorktree(workspace, slug);
        const info = result.info;
        const lines = [
          `Worktree: ${info.path}`,
          `Branch: ${info.branch}`,
          `HEAD: ${info.head}`,
          `Repository root: ${info.repoRoot}`,
        ];
        if (result.warnings.length) {
          lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
        }
        return {
          ok: true,
          output: lines.join("\n"),
          summary: `worktree ready (${info.branch})`,
          metadata: {
            path: info.path,
            branch: info.branch,
            head: info.head,
            repoRoot: info.repoRoot,
            ...(result.warnings.length ? { warnings: result.warnings } : {}),
          },
        };
      } catch (error) {
        return failedResult(error, "enter_worktree failed");
      }
    },
  };
}

function exitWorktreeDefinition(fallbackWorkspace: string): ToolDefinition {
  return {
    name: "exit_worktree",
    description:
      "Leave and clean up a Git worktree. Pass the worktree path, branch, and repository root returned by enter_worktree. " +
      "When a baseline commit is provided, deletion is blocked if the worktree has uncommitted changes or its HEAD differs " +
      "from the baseline. With no baseline, the worktree is removed unconditionally.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute worktree path returned by enter_worktree." },
        branch: { type: "string", description: "Worktree branch name returned by enter_worktree." },
        repoRoot: { type: "string", description: "Absolute repository root returned by enter_worktree." },
        baseline: {
          type: "string",
          description: "Optional baseline commit SHA. When provided, dirty worktrees are preserved.",
        },
      },
      required: ["path", "branch", "repoRoot"],
    },
    permissionLevel: 3,
    kind: "command",
    deferred: true,
    maxOutputChars: 16_000,
    invoke: async (call, context) => {
      const workspace = context?.workspace ?? fallbackWorkspace;
      const rawPath = call.arguments.path;
      const branch = String(call.arguments.branch ?? "").trim();
      const rawRepoRoot = call.arguments.repoRoot;
      const baseline = call.arguments.baseline === undefined ? undefined : String(call.arguments.baseline).trim();

      if (
        typeof rawPath !== "string" ||
        !rawPath.trim() ||
        !branch ||
        typeof rawRepoRoot !== "string" ||
        !rawRepoRoot.trim()
      ) {
        return {
          ok: false,
          output: "",
          error: "exit_worktree requires path, branch, and repoRoot",
          summary: "missing arguments",
        };
      }
      if (!isSafeBranchName(branch)) {
        return { ok: false, output: "", error: `unsafe branch name: ${branch}`, summary: "invalid branch" };
      }
      const shortBranch = shortBranchName(branch);
      const branchPrefix = "worktree-";
      if (!shortBranch.startsWith(branchPrefix)) {
        return {
          ok: false,
          output: "",
          error: `branch is not managed by Oran worktrees: ${shortBranch}`,
          summary: "invalid branch",
        };
      }
      const slug = shortBranch.slice(branchPrefix.length);
      if (!isValidSlug(slug)) {
        return {
          ok: false,
          output: "",
          error: `invalid worktree branch slug: ${slug || "(empty)"}`,
          summary: "invalid branch",
        };
      }

      try {
        const repoRootPath = resolve(workspace, rawRepoRoot);
        const worktreePath = resolve(workspace, rawPath);
        const verifiedRepoRoot = await resolveRepoRoot(repoRootPath);
        if (!sameResolvedPath(repoRootPath, verifiedRepoRoot)) {
          throw new Error(`repoRoot is not a repository root: ${repoRootPath}`);
        }
        const expectedWorktreePath = worktreeDirectory(repoRootPath, slug);
        if (!sameResolvedPath(worktreePath, expectedWorktreePath)) {
          throw new Error(`path does not match the managed worktree location: ${expectedWorktreePath}`);
        }
        const workspaceRepoRoot = await resolveRepoRoot(workspace);
        const belongsToWorkspace =
          sameResolvedPath(repoRootPath, workspaceRepoRoot) ||
          sameResolvedPath(worktreePath, workspaceRepoRoot) ||
          sameResolvedPath(worktreePath, workspace);
        if (!belongsToWorkspace)
          throw new Error("repoRoot and worktree path are not associated with the current workspace");

        let changed = false;
        if (baseline) {
          changed = await hasChanges(worktreePath, baseline);
        }
        if (!changed) {
          const result = await cleanupWorktree(repoRootPath, worktreePath, shortBranch);
          if (!result.ok) {
            const detail = result.steps
              .filter((step) => !step.ok)
              .map((step) => `${step.name}: ${step.error ?? "failed"}`)
              .join("; ");
            return {
              ok: false,
              output: "",
              error: `worktree cleanup failed: ${detail}`,
              summary: "cleanup failed",
              metadata: { steps: result.steps },
            };
          }
          return {
            ok: true,
            output: `cleaned worktree: ${worktreePath}`,
            summary: "cleaned",
            metadata: { path: worktreePath, branch: shortBranch, changed: false },
          };
        }
        return {
          ok: true,
          output: [
            "worktree has changes; nothing was deleted",
            `Worktree: ${worktreePath}`,
            `Branch: ${shortBranch}`,
            `Prompt for the next step:\n${worktreePromptText(worktreePath, repoRootPath)}`,
          ].join("\n"),
          summary: "changes detected",
          metadata: { changed: true, path: worktreePath, branch: shortBranch },
        };
      } catch (error) {
        return failedResult(error, "exit_worktree failed");
      }
    },
  };
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/, "");
  const normalizedRight = resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function failedResult(error: unknown, fallback: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, output: "", error: message || fallback, summary: "error" };
}
