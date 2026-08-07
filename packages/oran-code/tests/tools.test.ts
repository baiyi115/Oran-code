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
      await expect(registry.invoke({ name: "apply_patch", arguments: { path: "../escape.txt", content: "bad" }, createdAt: new Date().toISOString() })).rejects.toThrow(/escapes workspace/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
