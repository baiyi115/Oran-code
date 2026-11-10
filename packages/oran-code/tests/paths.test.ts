import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStateOutOfWorkspace, projectStateRoot, userSessionsRoot, workspaceDataPath } from "../src/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.ORAN_USER_DATA_DIR;
});

describe("migrateStateOutOfWorkspace", () => {
  it("skips migration when the user data root lives inside the workspace (e.g. home-directory workspace)", async () => {
    // Reproduction: when oran is started in the home directory, ~/.oran sits inside
    // workspace/.oran, and before the fix it renamed the sessions directory into itself,
    // throwing EINVAL.
    const workspace = await mkdtemp(join(tmpdir(), "oran-paths-"));
    roots.push(workspace);
    const userRoot = join(workspace, ".oran");
    process.env.ORAN_USER_DATA_DIR = userRoot;
    await mkdir(join(userRoot, "sessions"), { recursive: true });

    await expect(migrateStateOutOfWorkspace(workspace)).resolves.toBeUndefined();

    // Migration is skipped: the original directory stays put and is not renamed.
    const projectRootEntries = await readdir(join(projectStateRoot(workspace)));
    expect(projectRootEntries).toContain("sessions");
  });

  it("still migrates when the user data root is outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-paths-"));
    roots.push(workspace);
    const userRoot = await mkdtemp(join(tmpdir(), "oran-paths-user-"));
    roots.push(userRoot);
    process.env.ORAN_USER_DATA_DIR = userRoot;
    await mkdir(join(projectStateRoot(workspace), "sessions"), { recursive: true });
    await writeFile(join(projectStateRoot(workspace), "sessions", "demo.jsonl"), "{}", "utf8");

    await migrateStateOutOfWorkspace(workspace);

    // After moving out, the project directory no longer has sessions; the data lands in the
    // hashed subdirectory under the user directory. Nothing else was in .oran, so it is pruned.
    expect(existsSync(projectStateRoot(workspace))).toBe(false);
    const userSessions = await readdir(userSessionsRoot(workspace));
    expect(userSessions).toContain("demo.jsonl");
  });

  it("moves runtime state out while keeping project configuration in .oran", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-paths-"));
    roots.push(workspace);
    const userRoot = await mkdtemp(join(tmpdir(), "oran-paths-user-"));
    roots.push(userRoot);
    process.env.ORAN_USER_DATA_DIR = userRoot;
    await mkdir(join(projectStateRoot(workspace), "checkpoints"), { recursive: true });
    await writeFile(join(projectStateRoot(workspace), "checkpoints", "s1.json"), "{}", "utf8");
    await mkdir(join(projectStateRoot(workspace), "agents"), { recursive: true });
    await writeFile(join(projectStateRoot(workspace), "agents", "state.json"), "{}", "utf8");
    await writeFile(join(projectStateRoot(workspace), "agents", "reviewer.md"), "# reviewer", "utf8");
    await writeFile(join(projectStateRoot(workspace), "config.json"), "{}", "utf8");

    await migrateStateOutOfWorkspace(workspace);

    expect((await readdir(projectStateRoot(workspace))).sort()).toEqual(["agents", "config.json"]);
    expect(await readdir(join(projectStateRoot(workspace), "agents"))).toEqual(["reviewer.md"]);
    expect(existsSync(workspaceDataPath(workspace, "checkpoints", "s1.json"))).toBe(true);
    expect(existsSync(workspaceDataPath(workspace, "agents", "state.json"))).toBe(true);
  });
});
