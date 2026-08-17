import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_SUBAGENT_ALLOWED_TOOLS } from "../src/subagent/filter.js";
import { AgentDefinitionLoader } from "../src/subagent/roles.js";
import { registerBuiltinTools, ToolRegistry } from "../src/tools.js";
import { parseHeadFile, readWorktreeHead, resolveGitDir } from "../src/worktree/git-fs.js";
import {
  cleanupWorktree,
  ensureWorktree,
  hasChanges,
  initializeWorktree,
  worktreeBranch,
  worktreeDirectory,
  worktreePromptText,
} from "../src/worktree/lifecycle.js";
import { isSafeBranchName, isSafeRefName, isValidSlug } from "../src/worktree/safety.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface GitFixture {
  readonly root: string;
  readonly head: string;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worktree safety", () => {
  it("accepts only bounded path-free slugs", () => {
    expect(isValidSlug("task-01_feature")).toBe(true);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("a".repeat(65))).toBe(false);
    expect(isValidSlug("feature.one")).toBe(false);
    expect(isValidSlug("../escape")).toBe(false);
    expect(isValidSlug("nested/path")).toBe(false);
    expect(() => worktreeDirectory("C:/repo", "../escape")).toThrow(/invalid worktree slug/);
  });

  it("rejects unsafe refs and branches", () => {
    expect(isSafeRefName("refs/heads/feature/demo")).toBe(true);
    expect(isSafeBranchName("refs/heads/feature-demo")).toBe(true);
    expect(isSafeRefName("-refs/heads/demo")).toBe(false);
    expect(isSafeRefName("/refs/heads/demo")).toBe(false);
    expect(isSafeRefName("refs//heads/demo")).toBe(false);
    expect(isSafeRefName("refs/heads/../main")).toBe(false);
    expect(isSafeRefName("refs/heads/demo.lock@")).toBe(false);
  });
});

describe("filesystem git state", () => {
  it("parses symbolic and detached HEAD files", () => {
    expect(parseHeadFile("ref: refs/heads/demo\n")).toEqual({ kind: "ref", ref: "refs/heads/demo" });
    expect(parseHeadFile("A".repeat(40))).toEqual({ kind: "sha", sha: "a".repeat(40) });
    expect(parseHeadFile("not-a-head")).toBeUndefined();
  });

  it("resolves .git files and shared packed refs without git subprocesses", async () => {
    const root = await temporaryDirectory("oran-worktree-git-fs-");
    const worktree = join(root, "checkout");
    const commonDir = join(root, "common.git");
    const gitDir = join(commonDir, "worktrees", "checkout");
    const sha = "1".repeat(40);
    await mkdir(gitDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    await writeFile(join(gitDir, "commondir"), "../..\n", "utf8");
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/demo\n", "utf8");
    await writeFile(join(commonDir, "packed-refs"), `# pack-refs\n${sha} refs/heads/demo\n^${"2".repeat(40)}\n`, "utf8");

    expect(await resolveGitDir(worktree)).toBe(resolve(gitDir));
    expect(await readWorktreeHead(worktree)).toEqual({ commit: sha, branch: "demo" });

    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/../unsafe\n", "utf8");
    expect(await readWorktreeHead(worktree)).toEqual({ commit: "", branch: undefined });

    await writeFile(join(worktree, ".git"), `unexpected\ngitdir: ${gitDir}\n`, "utf8");
    expect(await resolveGitDir(worktree)).toBeUndefined();
  });

  it("reads detached HEAD directly", async () => {
    const root = await temporaryDirectory("oran-worktree-detached-");
    const gitDir = join(root, ".git");
    const sha = "a".repeat(40);
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "HEAD"), `${sha}\n`, "utf8");
    expect(await readWorktreeHead(root)).toEqual({ commit: sha, branch: undefined });
  });
});

describe("worktree lifecycle", () => {
  it("uses the existing-directory fast recovery path", async () => {
    const fixture = await createGitFixture("oran-worktree-recovery-");
    const worktree = worktreeDirectory(fixture.root, "recover");
    await mkdir(dirname(worktree), { recursive: true });
    await runGit(fixture.root, ["worktree", "add", "-B", worktreeBranch("recover"), worktree, "HEAD"]);

    await expect(ensureWorktree(fixture.root, "recover")).resolves.toEqual({
      info: {
        path: worktree,
        branch: worktreeBranch("recover"),
        head: fixture.head,
        repoRoot: fixture.root,
      },
      warnings: [],
    });
  });

  it("detects dirty files, HEAD advancement, and failures fail-closed", async () => {
    const fixture = await createGitFixture("oran-worktree-changes-");
    expect(await hasChanges(fixture.root, fixture.head)).toBe(false);

    await writeFile(join(fixture.root, "README.md"), "dirty\n", "utf8");
    expect(await hasChanges(fixture.root, fixture.head)).toBe(true);

    await runGit(fixture.root, ["checkout", "--", "README.md"]);
    await writeFile(join(fixture.root, "next.txt"), "next\n", "utf8");
    await runGit(fixture.root, ["add", "next.txt"]);
    await commit(fixture.root, "next");
    expect(await hasChanges(fixture.root, fixture.head)).toBe(true);
    expect(await hasChanges(join(fixture.root, "missing"), fixture.head)).toBe(true);
  });

  it("contains cleanup failures and remains safe to call repeatedly", async () => {
    const fixture = await createGitFixture("oran-worktree-cleanup-");
    const path = worktreeDirectory(fixture.root, "clean");
    const branch = worktreeBranch("clean");
    await mkdir(dirname(path), { recursive: true });
    await runGit(fixture.root, ["worktree", "add", "-b", branch, path, "HEAD"]);

    await expect(cleanupWorktree(fixture.root, path, branch)).resolves.toMatchObject({ ok: true });
    const repeated = await cleanupWorktree(fixture.root, path, branch);
    expect(repeated.ok).toBe(false);
    expect(repeated.steps).toHaveLength(2);
    expect(repeated.steps.every((step) => !step.ok && Boolean(step.error))).toBe(true);
  });

  it("initializes only whitelisted config and safe include entries", async () => {
    const root = await temporaryDirectory("oran-worktree-init-");
    const worktree = join(root, "checkout");
    await mkdir(join(root, ".oran", "agents"), { recursive: true });
    await mkdir(join(root, ".oran", "sessions"), { recursive: true });
    await mkdir(join(root, "runtime"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, ".oran", "agents", "reviewer.md"), "agent", "utf8");
    await writeFile(join(root, ".oran", "config.json"), "{}", "utf8");
    await writeFile(join(root, ".oran", "AGENTS.md"), "instructions", "utf8");
    await writeFile(join(root, ".oran", "sessions", "session.json"), "runtime", "utf8");
    await writeFile(join(root, ".oran", "state.db"), "runtime", "utf8");
    await writeFile(join(root, "runtime", "needed.txt"), "needed", "utf8");
    await writeFile(join(root, ".worktreeinclude"), "# comment\n.\nruntime/needed.txt\n../escape.txt\n", "utf8");

    await expect(initializeWorktree(root, worktree)).resolves.toEqual([]);
    await expect(readFile(join(worktree, ".oran", "agents", "reviewer.md"), "utf8")).resolves.toBe("agent");
    await expect(readFile(join(worktree, ".oran", "config.json"), "utf8")).resolves.toBe("{}");
    await expect(readFile(join(worktree, ".oran", "AGENTS.md"), "utf8")).resolves.toBe("instructions");
    await expect(readFile(join(worktree, "runtime", "needed.txt"), "utf8")).resolves.toBe("needed");
    await expect(readFile(join(worktree, ".oran", "sessions", "session.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(worktree, ".oran", "state.db"), "utf8")).rejects.toThrow();
  });

  it("renders an explicit isolation prompt", () => {
    expect(worktreePromptText("C:/repo/.oran/worktrees/a", "C:/repo")).toContain("isolated Git worktree");
    expect(worktreePromptText("C:/repo/.oran/worktrees/a", "C:/repo")).toContain("Parent repository: C:/repo");
  });
});

describe("deferred worktree tools", () => {
  it("discovers and activates worktree tools on demand", async () => {
    const workspace = await temporaryDirectory("oran-worktree-tools-");
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, workspace);

    expect(schemaNames(registry)).toContain("search_tools");
    expect(schemaNames(registry)).not.toContain("enter_worktree");
    expect(schemaNames(registry)).not.toContain("exit_worktree");
    await expect(invoke(registry, "enter_worktree", { slug: "demo" })).resolves.toMatchObject({ ok: false, summary: "not activated" });

    const found = await invoke(registry, "search_tools", { query: "worktree" });
    expect(found.ok).toBe(true);
    expect(found.output).toContain("enter_worktree");
    expect(found.output).toContain("exit_worktree");

    await expect(invoke(registry, "search_tools", { query: "select:enter_worktree" })).resolves.toMatchObject({ ok: true, summary: "activated enter_worktree" });
    expect(schemaNames(registry)).toContain("enter_worktree");
    expect(schemaNames(registry)).not.toContain("exit_worktree");
    await invoke(registry, "search_tools", { query: "select:exit_worktree" });
    await expect(invoke(registry, "exit_worktree", { path: workspace, branch: "main", repoRoot: workspace }))
      .resolves.toMatchObject({ ok: false, summary: "invalid branch" });
  });

  it("runs commands in a safe relative cwd", async () => {
    const workspace = await temporaryDirectory("oran-command-cwd-");
    const subdirectory = join(workspace, "subdir");
    await mkdir(subdirectory, { recursive: true });
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, workspace);

    const result = await invoke(registry, "run_command", { command: "node -e \"console.log(process.cwd())\"", cwd: "subdir" });
    expect(result.ok).toBe(true);
    expect(result.output.trim().toLowerCase()).toBe(subdirectory.toLowerCase());
    await expect(invoke(registry, "run_command", { command: "node --version", cwd: "../escape" })).resolves.toMatchObject({ ok: false, summary: "invalid arguments" });
  });
});

describe("subagent isolation metadata", () => {
  it("allows discovery and worktree tools for background subagents", () => {
    expect(BACKGROUND_SUBAGENT_ALLOWED_TOOLS.has("search_tools")).toBe(true);
    expect(BACKGROUND_SUBAGENT_ALLOWED_TOOLS.has("enter_worktree")).toBe(true);
    expect(BACKGROUND_SUBAGENT_ALLOWED_TOOLS.has("exit_worktree")).toBe(true);
  });
  it("preserves the isolation frontmatter field", async () => {
    const root = await temporaryDirectory("oran-agent-isolation-");
    const user = join(root, "user");
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "isolated.md"), [
      "---",
      "name: isolated",
      "description: Work inside an isolated checkout.",
      "isolation: worktree",
      "---",
      "Use worktree tools when isolation is needed.",
    ].join("\n"), "utf8");

    const loader = new AgentDefinitionLoader(root, { user, project });
    await loader.scan();
    expect(loader.get("isolated")?.isolationMode).toBe("worktree");
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function createGitFixture(prefix: string): Promise<GitFixture> {
  const root = await temporaryDirectory(prefix);
  await runGit(root, ["init"]);
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await commit(root, "initial");
  const head = (await runGit(root, ["rev-parse", "HEAD"])).trim().toLowerCase();
  return { root, head };
}

async function commit(root: string, message: string): Promise<void> {
  await runGit(root, ["-c", "user.name=Oran Test", "-c", "user.email=oran-test@example.invalid", "commit", "-m", message]);
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout;
}

function schemaNames(registry: ToolRegistry): string[] {
  return registry.schemas().map((schema) => String((schema.function as { name?: unknown }).name ?? ""));
}

function invoke(registry: ToolRegistry, name: string, args: Record<string, unknown>) {
  return registry.invoke({ name, arguments: args, createdAt: new Date().toISOString() });
}
