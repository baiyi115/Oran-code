import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectInstructions } from "../src/project-instructions.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("loadProjectInstructions", () => {
  it("loads user, hierarchy, legacy, and local sources from low to high priority", async () => {
    const fixture = await createFixture();
    const project = join(fixture.root, "project");
    const workspace = join(project, "packages", "app");
    await mkdir(join(fixture.home, ".liteagent"), { recursive: true });
    await mkdir(join(workspace, ".litecode"), { recursive: true });
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(fixture.home, ".liteagent", "LITEAGENT.md"), "user", "utf8");
    await writeFile(join(project, "AGENTS.md"), "root", "utf8");
    await writeFile(join(project, "packages", "AGENTS.md"), "parent", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "workspace", "utf8");
    await writeFile(join(workspace, ".litecode", "INSTRUCTIONS.md"), "legacy", "utf8");
    await writeFile(join(workspace, ".litecode", "INSTRUCTIONS.local.md"), "local", "utf8");

    const result = await loadProjectInstructions({ workspace, userHome: fixture.home });

    expectInOrder(result, ["user", "root", "parent", "workspace", "legacy", "local"]);
    expect(result.match(/instructions-source:/g)).toHaveLength(6);
    expect(result.match(/\n---\n/g)).toHaveLength(5);
  });

  it("expands all explicit path forms while blocking relative escapes", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "project");
    const external = join(fixture.root, "external.md");
    await mkdir(join(workspace, "docs"), { recursive: true });
    await mkdir(fixture.home, { recursive: true });
    await writeFile(join(workspace, "docs", "relative.md"), "relative body", "utf8");
    await writeFile(join(fixture.home, "home.md"), "home body", "utf8");
    await writeFile(external, "absolute body", "utf8");
    await writeFile(
      join(workspace, "AGENTS.md"),
      ["@docs/relative.md", "@~/home.md", `@${external}`, "@../external.md", "@missing.md"].join("\n"),
      "utf8",
    );

    const result = await loadProjectInstructions({ workspace, repositoryRoot: workspace, userHome: fixture.home });

    expect(result).toContain("relative body");
    expect(result).toContain("home body");
    expect(result).toContain("absolute body");
    expect(result).not.toContain("@../external.md");
    expect(result).not.toContain("@missing.md");
    expect(result.match(/include-source:/g)).toHaveLength(3);
  });

  it("handles escapes, whitespace, code fences, cycles, and depth limits", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "project");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "AGENTS.md"),
      ["@@literal.md", "@has whitespace.md", "```text", "@inside-fence.md", "```", "@a.md"].join("\n"),
      "utf8",
    );
    await writeFile(join(workspace, "a.md"), "A\n@b.md", "utf8");
    await writeFile(join(workspace, "b.md"), "B\n@a.md", "utf8");

    const result = await loadProjectInstructions({
      workspace,
      repositoryRoot: workspace,
      userHome: fixture.home,
      maxIncludeDepth: 2,
    });

    expect(result).toContain("@literal.md");
    expect(result).not.toContain("@@literal.md");
    expect(result).toContain("@has whitespace.md");
    expect(result).toContain("@inside-fence.md");
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("@a.md");
    expect(result.match(/include-source:/g)).toHaveLength(2);
  });

  it("returns an empty string when no instruction files exist", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "project");
    await mkdir(workspace, { recursive: true });

    await expect(
      loadProjectInstructions({ workspace, repositoryRoot: workspace, userHome: fixture.home }),
    ).resolves.toBe("");
  });
});

async function createFixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "liteagent-instructions-"));
  fixtures.push(root);
  return { root, home: resolve(root, "home") };
}

function expectInOrder(value: string, fragments: readonly string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const index = value.indexOf(fragment);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}
