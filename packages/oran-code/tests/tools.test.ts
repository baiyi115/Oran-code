import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFile, formatPreservingTail, registerBuiltinTools, ToolRegistry } from "../src/tools.js";
import { walkFiles } from "../src/tools/glob.js";

describe("builtin tools", () => {
  it("does not run a workspace-supplied outline CLI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    const home = await mkdtemp(join(tmpdir(), "liteagent-home-"));
    const marker = join(workspace, "payload-ran.txt");
    const previousCwd = process.cwd();
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      // A clean home, so the user's own installed CLI (the trusted location) cannot
      // exist and the only candidate left is the workspace one.
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const payloadDirectory = join(workspace, "node_modules", "showsignature", "dist");
      await mkdir(payloadDirectory, { recursive: true });
      await writeFile(
        join(payloadDirectory, "02-cli.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
        "utf8",
      );
      await writeFile(join(workspace, "src.ts"), 'export function greeting(): string {\n  return "hi";\n}\n', "utf8");
      // The resolver looks relative to the process cwd, and the agent is normally
      // started inside the repository it is asked about.
      process.chdir(workspace);

      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      registry.activateAll();
      const result = await registry.invoke({
        name: "show_signature",
        arguments: { path: "src.ts" },
        createdAt: new Date().toISOString(),
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("greeting");
      // show_signature is readonly, so this used to run with no approval at all.
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps file writes inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      registry.activateAll();
      await expect(
        registry.invoke({
          name: "write_file",
          arguments: { path: "note.txt", content: "ok" },
          createdAt: new Date().toISOString(),
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("ok");
      await expect(
        registry.invoke({
          name: "write_file",
          arguments: { path: "../escape.txt", content: "bad" },
          createdAt: new Date().toISOString(),
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("escapes workspace") });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("apply_patch applies a unified diff to an existing file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      registry.activateAll();
      await registry.invoke({
        name: "write_file",
        arguments: { path: "src/a.txt", content: "one\ntwo\nthree\n" },
        createdAt: new Date().toISOString(),
      });
      const result = await registry.invoke({
        name: "apply_patch",
        arguments: {
          path: "src/a.txt",
          diff: "@@ -2,1 +2,1 @@\n-two\n+TWO\n",
        },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(true);
      await expect(readFile(join(workspace, "src/a.txt"), "utf8")).resolves.toBe("one\nTWO\nthree\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("apply_patch rejects a diff that does not match", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      registry.activateAll();
      await registry.invoke({
        name: "write_file",
        arguments: { path: "a.txt", content: "one\ntwo\n" },
        createdAt: new Date().toISOString(),
      });
      const result = await registry.invoke({
        name: "apply_patch",
        arguments: {
          path: "a.txt",
          diff: "@@ -1,1 +1,1 @@\n-missing context\n+x\n",
        },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(false);
      await expect(readFile(join(workspace, "a.txt"), "utf8")).resolves.toBe("one\ntwo\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("apply_patch stays inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      registry.activateAll();
      const result = await registry.invoke({
        name: "apply_patch",
        arguments: { path: "../escape.txt", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(false);
      expect(String(result.error ?? "")).toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("defers non-core tools and activates them on demand via search_tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-deferred-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);

      // Core read/write, edit and command tools stay exposed by default
      expect(registry.isExposed("git_status")).toBe(true);
      expect(registry.isExposed("get_diff")).toBe(true);
      expect(registry.isExposed("write_file")).toBe(true);
      expect(registry.isExposed("edit_file")).toBe(true);
      expect(registry.isExposed("apply_patch")).toBe(true);
      expect(registry.isExposed("run_command")).toBe(true);

      // Experimental / low-frequency extension tools (e.g. the worktree tools) are deferred on demand
      expect(registry.isExposed("enter_worktree")).toBe(false);

      // Direct invocation before activation is rejected
      const directResult = await registry.invoke({
        name: "enter_worktree",
        arguments: { slug: "feature-test" },
        createdAt: new Date().toISOString(),
      });
      expect(directResult.ok).toBe(false);
      expect(directResult.error).toContain("tool is not activated: enter_worktree");

      // Search tools returns matching deferred tools
      const searchResult = await registry.invoke({
        name: "search_tools",
        arguments: { query: "worktree" },
        createdAt: new Date().toISOString(),
      });
      expect(searchResult.ok).toBe(true);
      expect(searchResult.output).toContain("enter_worktree");

      // Selecting the tool activates it and returns its parameter schema
      const selectResult = await registry.invoke({
        name: "search_tools",
        arguments: { query: "select:enter_worktree" },
        createdAt: new Date().toISOString(),
      });
      expect(selectResult.ok).toBe(true);
      expect(selectResult.output).toContain("parameters");
      expect(registry.isExposed("enter_worktree")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("atomicWriteFile writes and overwrites files reliably", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-atomic-"));
    try {
      const targetFile = join(workspace, "nested", "file.txt");
      await atomicWriteFile(targetFile, "first version");
      await expect(readFile(targetFile, "utf8")).resolves.toBe("first version");
      await atomicWriteFile(targetFile, "second version");
      await expect(readFile(targetFile, "utf8")).resolves.toBe("second version");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("formatPreservingTail preserves head and tail on oversized output", () => {
    const shortText = "short output";
    expect(formatPreservingTail(shortText, 100)).toBe(shortText);

    const longText = `HEADER_START_${"a".repeat(500)}_HEADER_END_MIDDLE_${"b".repeat(1000)}_MIDDLE_END_TAIL_START_${"c".repeat(500)}_TAIL_END`;
    const truncated = formatPreservingTail(longText, 200, 50);
    expect(truncated.length).toBeLessThanOrEqual(300);
    expect(truncated).toContain("HEADER_START");
    expect(truncated).toContain("TAIL_END");
    expect(truncated).toContain("truncated");
  });
});

describe("file walking", () => {
  /** A directory link: a junction where that is what works (Windows, no privileges), a symlink otherwise. */
  async function linkDirectory(target: string, path: string): Promise<boolean> {
    return symlink(target, path, "junction")
      .then(() => true)
      .catch(() =>
        symlink(target, path, "dir")
          .then(() => true)
          .catch(() => false),
      );
  }

  it("follows links inside the walk root, once, and not the ones that leave it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-walk-"));
    const outside = await mkdtemp(join(tmpdir(), "liteagent-outside-"));
    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await writeFile(join(workspace, "src", "a.ts"), "export const a = 1;\n", "utf8");
      await writeFile(join(outside, "secret.ts"), "export const secret = 1;\n", "utf8");

      if (!(await linkDirectory(join(workspace, "src"), join(workspace, "linked")))) return;
      const fileLink = await symlink(join(workspace, "src", "a.ts"), join(workspace, "alias.ts"), "file")
        .then(() => true)
        .catch(() => false);
      await linkDirectory(outside, join(workspace, "escape"));

      const seen: string[] = [];
      await walkFiles(workspace, async (filePath) => {
        seen.push(relative(workspace, filePath).replaceAll("\\", "/"));
      });
      const sorted = [...seen].sort();

      expect(sorted).toContain("src/a.ts");
      // The linked directory is the same physical directory, so it is walked once:
      // a link back up the tree cannot make this unbounded, and a file is not
      // reported under two paths.
      expect(sorted).not.toContain("linked/a.ts");
      // A link that leaves the walk root is not followed: a repository should not be
      // able to make these tools read files outside the workspace.
      expect(sorted.some((path) => path.includes("escape") || path.includes("secret"))).toBe(false);
      // A file link needs privileges on Windows, so that half of the assertion is
      // conditional; a directory link is available on both platforms.
      if (fileLink) expect(sorted).toContain("alias.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("show_signature", () => {
  it("lists exported functions and classes when only exports are asked for", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    const home = await mkdtemp(join(tmpdir(), "liteagent-home-"));
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      // A clean home keeps the optional external outline CLI out of the way.
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      await writeFile(join(workspace, "api.ts"), "export function handler() {}\nexport const LIMIT = 1;\n", "utf8");
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      registry.activateAll();
      const result = await registry.invoke({
        name: "show_signature",
        arguments: { path: "api.ts", only: "exports" },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(true);
      // A function or class line is listed by the signature branch, so switching that
      // branch off used to make every exported function and class disappear.
      expect(result.output).toContain("export function handler");
      expect(result.output).toContain("export const LIMIT");
    } finally {
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("search_code", () => {
  async function search(workspace: string, pattern: string): Promise<{ output: string; durationMs: number }> {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, workspace);
    registry.activateAll();
    const started = Date.now();
    const result = await registry.invoke({
      name: "search_code",
      arguments: { pattern, path: "." },
      createdAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    return { output: result.output, durationMs: Date.now() - started };
  }

  it("finds matches and reports the file and line", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      await writeFile(join(workspace, "a.ts"), "const needle = 1;\n", "utf8");
      const { output } = await search(workspace, "needle");
      expect(output).toContain("a.ts:1:");
      expect(output).toContain("needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("stops a pattern that backtracks catastrophically instead of freezing the agent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      // Exponential backtracking needs tens of characters, not a long line: this
      // run of identical characters makes `(a+)+b` never return. The scan is
      // synchronous, so its own budget cannot interrupt it — only killing the
      // process it runs in can, which is why the search runs in a host.
      await writeFile(join(workspace, "blob.txt"), `${"a".repeat(40)}\nboring line\n`, "utf8");
      const { output, durationMs } = await search(workspace, "(a+)+b");
      expect(output).toContain("search interrupted");
      expect(output).toContain("(a+)+");
      expect(durationMs).toBeLessThan(15_000);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
