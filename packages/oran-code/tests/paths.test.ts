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
    // 复现:在主目录启动 oran 时,~/.oran 就在 workspace/.oran 之内,
    // 修复前会把 sessions 目录 rename 进自身而抛 EINVAL。
    const workspace = await mkdtemp(join(tmpdir(), "oran-paths-"));
    roots.push(workspace);
    const userRoot = join(workspace, ".oran");
    process.env.ORAN_USER_DATA_DIR = userRoot;
    await mkdir(join(userRoot, "sessions"), { recursive: true });

    await expect(migrateUserDataOutOfWorkspace(workspace)).resolves.toBeUndefined();

    // 跳过迁移:原目录保持原位,未被改名。
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

    // 迁出后项目目录不再有 sessions,数据落到用户目录的哈希子目录。
    const projectRootEntries = await readdir(projectStateRoot(workspace));
    expect(projectRootEntries).not.toContain("sessions");
    const userSessions = await readdir(userSessionsRoot(workspace));
    expect(userSessions).toContain("demo.jsonl");
  });
});
