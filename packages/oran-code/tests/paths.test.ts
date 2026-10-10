import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUserDataOutOfWorkspace, projectStateRoot, userSessionsRoot } from "../src/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.ORAN_USER_DATA_DIR;
});

describe("migrateUserDataOutOfWorkspace", () => {
  it("skips migration when the user data root lives inside the workspace (e.g. home-directory workspace)", async () => {
    // Reproduction: when oran is started in the home directory, ~/.oran sits inside
    // workspace/.oran, and before the fix it renamed the sessions directory into itself,
    // throwing EINVAL.
    const workspace = await mkdtemp(join(tmpdir(), "oran-paths-"));
    roots.push(workspace);
    const userRoot = join(workspace, ".oran");
    process.env.ORAN_USER_DATA_DIR = userRoot;
    await mkdir(join(userRoot, "sessions"), { recursive: true });

    await expect(migrateUserDataOutOfWorkspace(workspace)).resolves.toBeUndefined();

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

    await migrateUserDataOutOfWorkspace(workspace);

    // After moving out, the project directory no longer has sessions; the data lands in the
    // hashed subdirectory under the user directory.
    const projectRootEntries = await readdir(projectStateRoot(workspace));
    expect(projectRootEntries).not.toContain("sessions");
    const userSessions = await readdir(userSessionsRoot(workspace));
    expect(userSessions).toContain("demo.jsonl");
  });
});
