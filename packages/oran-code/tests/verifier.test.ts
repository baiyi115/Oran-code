import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Verifier } from "../src/verifier.js";
import type { VerificationResult } from "../src/types.js";

async function withWorkspace(
  files: Record<string, string>,
  fn: (workspace: string) => void | Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "oran-verifier-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(workspace, relative);
      await writeFile(path, content, "utf8");
    }
    await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("Verifier.inferCommands", () => {
  it("uses pnpm test for a pnpm workspace with a test script", async () => {
    await withWorkspace(
      {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "package.json": JSON.stringify({ scripts: { test: "pnpm --filter @oran-code/cli test" } }),
      },
      (workspace) => {
        expect(Verifier.inferCommands(workspace)).toContain("pnpm test");
      },
    );
  });

  it("uses npm test for a plain package.json with a test script", async () => {
    await withWorkspace(
      {
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      },
      (workspace) => {
        expect(Verifier.inferCommands(workspace)).toContain("npm test");
      },
    );
  });

  it("detects pnpm from the packageManager field", async () => {
    await withWorkspace(
      {
        "package.json": JSON.stringify({ packageManager: "pnpm@10.30.3", scripts: { test: "vitest run" } }),
      },
      (workspace) => {
        expect(Verifier.inferCommands(workspace)).toContain("pnpm test");
      },
    );
  });

  it("emits no node command when package.json has no test script", async () => {
    await withWorkspace(
      {
        "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      },
      (workspace) => {
        const commands = Verifier.inferCommands(workspace);
        expect(commands.some((command) => command.includes("npm test") || command.includes("pnpm test"))).toBe(false);
      },
    );
  });

  it("emits no node command when package.json is absent", async () => {
    await withWorkspace({}, (workspace) => {
      const commands = Verifier.inferCommands(workspace);
      expect(commands.some((command) => command.includes("npm test") || command.includes("pnpm test"))).toBe(false);
    });
  });

  it("infers pytest for a pyproject.toml project", async () => {
    await withWorkspace(
      {
        "pyproject.toml": '[project]\nname = "demo"\n',
      },
      (workspace) => {
        const commands = Verifier.inferCommands(workspace);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toContain("-m pytest -q");
      },
    );
  });
});

describe("Verifier.runMany", () => {
  it("runs commands in order and stops after the first failure", async () => {
    const verifier = new Verifier(".");
    const run = vi
      .spyOn(verifier, "run")
      .mockResolvedValueOnce(result("typecheck", true))
      .mockResolvedValueOnce(result("build", false))
      .mockResolvedValueOnce(result("test", true));

    const results = await verifier.runMany(["typecheck", "build", "test"]);

    expect(results).toEqual([result("typecheck", true), result("build", false)]);
    expect(run.mock.calls.map(([command]) => command)).toEqual(["typecheck", "build"]);
  });
});

function result(command: string, passed: boolean): VerificationResult {
  return { command, exitCode: passed ? 0 : 1, output: passed ? "ok" : "failed", durationMs: 1, passed };
}
