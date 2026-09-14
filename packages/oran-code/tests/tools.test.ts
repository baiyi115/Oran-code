import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFile, formatPreservingTail, registerBuiltinTools, ToolRegistry } from "../src/tools.js";

describe("builtin tools", () => {
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

      // 核心读写、修改与命令工具默认常驻暴露
      expect(registry.isExposed("git_status")).toBe(true);
      expect(registry.isExposed("get_diff")).toBe(true);
      expect(registry.isExposed("write_file")).toBe(true);
      expect(registry.isExposed("edit_file")).toBe(true);
      expect(registry.isExposed("apply_patch")).toBe(true);
      expect(registry.isExposed("run_command")).toBe(true);

      // 实验性/低频扩展工具(如 worktree 工具)按需延迟暴露
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
