import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerBuiltinTools, ToolRegistry } from "../src/tools.js";
import { registerAllLanguages } from "../src/graph/languages/all.js";
import { coveredLanguageLabels } from "../src/graph/languages/registry.js";

/**
 * The tool layer is the model's only entry point into "what the graph covers". This text has
 * drifted once already: 91b4469 grew the registry to 19 languages while the description still
 * said three, so the model fell back to grep in the other languages -- no error, just less use.
 * These assertions guard that seam.
 */
const workspaces: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true });
});

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "oran-graph-tools-"));
  workspaces.push(workspace);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content, "utf8");
  }
  return workspace;
}

function registryFor(workspace: string): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, workspace);
  return registry;
}

function call(name: string, args: Record<string, unknown>) {
  return { name, arguments: args, createdAt: new Date().toISOString() };
}

describe("code_impact tool surface", () => {
  it("is registered and exposed in the first round", () => {
    const registry = registryFor(process.cwd());
    expect(registry.listExposed().map((tool) => tool.name)).toContain("code_impact");
  });

  it("names every language the registry covers", () => {
    registerAllLanguages();
    const description = registryFor(process.cwd()).get("code_impact").description;
    for (const label of coveredLanguageLabels()) expect(description).toContain(label);
  });

  it("says a file is uncovered instead of blaming the path", async () => {
    const workspace = await makeWorkspace({ "src/a.ts": "export const a = 1;\n", "notes.md": "# notes\n" });
    const result = await registryFor(workspace).invoke(call("code_impact", { path: "notes.md" }));
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("does not cover");
  });

  it("counts tests-mode totals within the set it reports", async () => {
    const workspace = await makeWorkspace({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
      "tests/a.test.ts": 'import { a } from "../src/a";\nexport const t = a;\n',
    });
    const result = await registryFor(workspace).invoke(call("code_impact", { path: "src/a.ts", mode: "tests" }));
    expect(result.ok).toBe(true);
    // Both numbers on the first line must come from the same set: total used to come from the
    // filtered test set while direct came from the unfiltered full set, printing "1 total, 2 direct".
    expect(result.output).toContain(": 1 total, 1 direct");
  });
});
