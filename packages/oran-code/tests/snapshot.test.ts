import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "../src/snapshot.js";
import { createTask } from "../src/types.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SnapshotStore /undo", () => {
  it("records and undoes the latest agent file change batch", async () => {
    const root = await createSnapshotFixture("oran-snapshot-undo-");
    const store = new SnapshotStore(root);
    const task = createTask(root, "modify files");
    task.id = "task-1";
    await store.begin("session-1", task);
    await writeFile(join(root, "README.md"), "updated", "utf8");
    await writeFile(join(root, "added.txt"), "new", "utf8");
    await store.finalize(task);
    expect(await store.list("session-1")).toHaveLength(1);

    const result = await store.undoLatest("session-1");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("task-1");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("initial");
    await expect(readFile(join(root, "added.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const [manifest] = await store.list("session-1");
    expect(manifest?.status).toBe("undone");
  });

  it("refuses when the post-task files were modified again, then retries after conflict resolved", async () => {
    const root = await createSnapshotFixture("oran-snapshot-conflict-");
    const store = new SnapshotStore(root);
    const task = createTask(root, "agent edit");
    task.id = "task-conflict";
    await store.begin("session-conflict", task);
    await writeFile(join(root, "README.md"), "agent", "utf8");
    await store.finalize(task);
    await writeFile(join(root, "README.md"), "manual", "utf8");

    const refused = await store.undoLatest("session-conflict");
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("Undo refused");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("manual");
    const [conflict] = await store.list("session-conflict");
    expect(conflict?.status).toBe("conflicted");

    await writeFile(join(root, "README.md"), "agent", "utf8");
    const retried = await store.undoLatest("session-conflict");
    expect(retried.ok).toBe(true);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("initial");
  });

  it("refuses to undo when HEAD changed during or after the task", async () => {
    const root = await createSnapshotFixture("oran-snapshot-head-");
    const store = new SnapshotStore(root);
    const task = createTask(root, "commit during task");
    task.id = "task-head";
    await store.begin("session-head", task);
    await writeFile(join(root, "README.md"), "committed", "utf8");
    await runGit(root, ["add", "README.md"]);
    await commit(root, "mid-task");
    await store.finalize(task);

    const result = await store.undoLatest("session-head");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("HEAD changed");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("committed");
  });

  it("does not skip a newer open snapshot to undo an older batch", async () => {
    const root = await createSnapshotFixture("oran-snapshot-stack-");
    const store = new SnapshotStore(root);
    const first = createTask(root, "first");
    first.id = "task-old";
    await store.begin("session-stack", first);
    await writeFile(join(root, "README.md"), "first", "utf8");
    await store.finalize(first);

    const second = createTask(root, "second");
    second.id = "task-new";
    await store.begin("session-stack", second);
    const refused = await store.undoLatest("session-stack");
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("incomplete");

    await store.finalize(second);
    const result = await store.undoLatest("session-stack");
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("initial");
  });

  it("restores binary file content as bytes", async () => {
    const root = await createSnapshotFixture("oran-snapshot-binary-");
    await writeFile(join(root, "bin.bin"), "plain", "utf8");
    await runGit(root, ["add", "bin.bin"]);
    await commit(root, "seed binary");

    const store = new SnapshotStore(root);
    const task = createTask(root, "binary edit");
    task.id = "task-binary";
    await store.begin("session-binary", task);
    await writeFile(join(root, "bin.bin"), Buffer.from([0, 1, 255, 2]));
    await store.finalize(task);

    const result = await store.undoLatest("session-binary");
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "bin.bin"), "utf8")).toBe("plain");
  });
});

async function createSnapshotFixture(prefix: string): Promise<string> {
  const root = await temporaryDirectory(prefix);
  await runGit(root, ["init"]);
  await writeFile(join(root, "README.md"), "initial", "utf8");
  await runGit(root, ["add", "README.md"]);
  await commit(root, "initial");
  return root;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function commit(root: string, message: string): Promise<void> {
  await runGit(root, [
    "-c",
    "user.name=Oran Test",
    "-c",
    "user.email=oran-test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout;
}
