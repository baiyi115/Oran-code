import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerBuiltinTools, ToolRegistry } from "../src/tools.js";

describe("builtin tools", () => {
  it("keeps file writes inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      await expect(registry.invoke({ name: "apply_patch", arguments: { path: "note.txt", content: "ok" }, createdAt: new Date().toISOString() })).resolves.toMatchObject({ ok: true });
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("ok");
      await expect(registry.invoke({ name: "apply_patch", arguments: { path: "../escape.txt", content: "bad" }, createdAt: new Date().toISOString() })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("escapes workspace") });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("apply_diff applies a unified diff to an existing file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      await registry.invoke({ name: "write_file", arguments: { path: "src/a.txt", content: "one\ntwo\nthree\n" }, createdAt: new Date().toISOString() });
      const result = await registry.invoke({
        name: "apply_diff",
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

  it("apply_diff rejects a diff that does not match", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      await registry.invoke({ name: "write_file", arguments: { path: "a.txt", content: "one\ntwo\n" }, createdAt: new Date().toISOString() });
      const result = await registry.invoke({
        name: "apply_diff",
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

  it("apply_diff stays inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      const result = await registry.invoke({
        name: "apply_diff",
        arguments: { path: "../escape.txt", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(false);
      expect(String(result.error ?? "")).toContain("escapes workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
