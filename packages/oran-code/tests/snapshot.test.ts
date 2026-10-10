import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("says which changed paths git ignores, since undo cannot restore them", async () => {
    const root = await createSnapshotFixture("oran-snapshot-ignored-");
    await writeFile(join(root, ".gitignore"), "generated/\n", "utf8");
    await runGit(root, ["add", ".gitignore"]);
    await commit(root, "ignore generated");

    const store = new SnapshotStore(root);
    const task = createTask(root, "edit a tracked file and an ignored one");
    task.id = "task-ignored";
    await store.begin("session-ignored", task);
    await writeFile(join(root, "README.md"), "updated", "utf8");
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "report.json"), "{}", "utf8");
    await store.finalize(task);

    const result = await store.undoLatest("session-ignored");
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("initial");
    // The snapshot is a pair of git trees, so the ignored file keeps the agent's
    // content; the message has to say so rather than read as a full rollback.
    expect(result.output).toContain("generated");
    expect(result.output).toContain("left as they are");
    expect(await readFile(join(root, "generated", "report.json"), "utf8")).toBe("{}");
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

describe("SnapshotStore /rewind files", () => {
  it("reverts every batch from the target turn onward and marks them undone", async () => {
    const root = await createSnapshotFixture("oran-snapshot-rewind-");
    const store = new SnapshotStore(root);

    const first = createTask(root, "first turn");
    first.id = "task-first";
    await store.begin("session-rewind", first);
    await writeFile(join(root, "README.md"), "after-first", "utf8");
    await store.finalize(first);

    const second = createTask(root, "second turn");
    second.id = "task-second";
    await store.begin("session-rewind", second);
    await writeFile(join(root, "README.md"), "after-second", "utf8");
    await writeFile(join(root, "second.txt"), "created later", "utf8");
    await store.finalize(second);

    const result = await store.restoreBefore("session-rewind", "task-first");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("README.md");
    expect(result.output).toContain("second.txt");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("initial");
    await expect(readFile(join(root, "second.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.list("session-rewind")).map((manifest) => manifest.status)).toEqual(["undone", "undone"]);
  });

  it("refuses when files changed after the target turns", async () => {
    const root = await createSnapshotFixture("oran-snapshot-rewind-conflict-");
    const store = new SnapshotStore(root);
    const first = createTask(root, "first turn");
    first.id = "task-conflict-first";
    await store.begin("session-rewind-conflict", first);
    await writeFile(join(root, "README.md"), "agent", "utf8");
    await store.finalize(first);
    await writeFile(join(root, "README.md"), "manual edit", "utf8");

    const refused = await store.restoreBefore("session-rewind-conflict", "task-conflict-first");
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("refused");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("manual edit");
  });

  it("refuses an incomplete chain instead of guessing", async () => {
    const root = await createSnapshotFixture("oran-snapshot-rewind-open-");
    const store = new SnapshotStore(root);
    const first = createTask(root, "first turn");
    first.id = "task-open-first";
    await store.begin("session-rewind-open", first);
    await writeFile(join(root, "README.md"), "first", "utf8");
    await store.finalize(first);

    const second = createTask(root, "second turn");
    second.id = "task-open-second";
    await store.begin("session-rewind-open", second);
    await writeFile(join(root, "README.md"), "second", "utf8");

    const refused = await store.restoreBefore("session-rewind-open", "task-open-first");
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("incomplete");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("second");
  });

  it("reports when the turn has no recorded snapshot", async () => {
    const root = await createSnapshotFixture("oran-snapshot-rewind-missing-");
    const store = new SnapshotStore(root);
    const result = await store.restoreBefore("session-rewind-missing", "task-unknown");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("No file snapshot is recorded");
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
