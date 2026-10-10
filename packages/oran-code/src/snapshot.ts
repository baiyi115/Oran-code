import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Task } from "./types.js";
import { projectStateRoot, PROJECT_STATE_DIR_NAMES } from "./paths.js";

const execFileAsync = promisify(execFile);

export type SnapshotStatus = "open" | "ready" | "undone" | "conflicted";

export interface SnapshotManifest {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly preTree: string;
  readonly postTree?: string;
  readonly preHead: string;
  readonly postHead?: string;
  readonly changedPaths: readonly string[];
  /**
   * Paths git ignores that were modified between `createdAt` and `completedAt`.
   *
   * The snapshot itself is a pair of git trees, so a file git ignores (.env, a
   * build directory, a local settings file) never enters `changedPaths` and undo
   * cannot restore it — while the undo message read as if the whole batch had been
   * rolled back. Recording them lets that message say what it left alone.
   */
  readonly ignoredChanges?: readonly string[];
  readonly status: SnapshotStatus;
  readonly undoneAt?: string;
}

export interface SnapshotStorePort {
  begin(sessionId: string, task: Task): Promise<void>;
  finalize(task: Task): Promise<void>;
  undoLatest(sessionId: string): Promise<{ ok: boolean; output: string }>;
  /** Rolls back to the state before the given task started, marking that task and every
   * snapshot after it as undone. */
  restoreBefore(sessionId: string, taskId: string): Promise<{ ok: boolean; output: string }>;
  list(sessionId?: string): Promise<readonly SnapshotManifest[]>;
}

export class SnapshotStore implements SnapshotStorePort {
  constructor(private readonly rootWorkspace: string) {}

  async begin(sessionId: string, task: Task): Promise<void> {
    const path = this.manifestPath(sessionId, task.id);
    if (await exists(path)) return;
    const preTree = await captureTree(task.workspace);
    const preHead = await gitHead(task.workspace);
    const manifest: SnapshotManifest = {
      version: 1,
      id: `${sessionId}:${task.id}`,
      sessionId,
      taskId: task.id,
      workspace: resolve(task.workspace),
      createdAt: new Date().toISOString(),
      preTree,
      preHead,
      changedPaths: [],
      status: "open",
    };
    await writeJsonAtomic(path, manifest);
  }

  async finalize(task: Task): Promise<void> {
    const files = await readdir(resolve(projectStateRoot(this.rootWorkspace), "snapshots"), {
      withFileTypes: true,
    }).catch(() => []);
    const manifestPath =
      (await this.findManifestPath(
        task.id,
        files.map((entry) => entry.name),
      )) ?? undefined;
    if (!manifestPath) return;
    const manifest = await readJson<SnapshotManifest>(manifestPath);
    if (!manifest || manifest.status !== "open") return;
    const postTree = await captureTree(task.workspace);
    const postHead = await gitHead(task.workspace);
    const preEntries = await treeEntries(manifest.preTree, task.workspace);
    const postEntries = await treeEntries(postTree, task.workspace);
    const changedPaths = [...new Set([...preEntries.keys(), ...postEntries.keys()])]
      .filter((path) => preEntries.get(path) !== postEntries.get(path))
      .sort();
    const ignoredChanges = await ignoredPathsChangedSince(task.workspace, manifest.createdAt);
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      completedAt: new Date().toISOString(),
      postTree,
      postHead,
      changedPaths,
      ...(ignoredChanges.length > 0 ? { ignoredChanges } : {}),
      status: "ready",
    } satisfies SnapshotManifest);
  }

  async list(sessionId?: string): Promise<readonly SnapshotManifest[]> {
    const snapshotRoot = resolve(projectStateRoot(this.rootWorkspace), "snapshots");
    const sessions = await readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
    const result: SnapshotManifest[] = [];
    for (const session of sessions) {
      if (!session.isDirectory() || (sessionId && session.name !== sessionId)) continue;
      const files = await readdir(resolve(snapshotRoot, session.name)).catch(() => []);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const manifest = await readJson<SnapshotManifest>(resolve(snapshotRoot, session.name, file));
        if (manifest) result.push(manifest);
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async undoLatest(sessionId: string): Promise<{ ok: boolean; output: string }> {
    let manifest: SnapshotManifest | undefined;
    for (const item of await this.list(sessionId)) {
      if (item.status === "undone") continue;
      if (item.status === "open") {
        return {
          ok: false,
          output: `Undo refused: the latest Agent snapshot (${item.taskId}) is incomplete. Inspect the working tree with Git before recovering older changes.`,
        };
      }
      if (item.changedPaths.length === 0) continue;
      manifest = item;
      break;
    }
    if (!manifest) return { ok: false, output: "No undoable Agent file change snapshot exists in this session." };
    if (!manifest.postTree) return { ok: false, output: "The latest snapshot is incomplete and cannot be undone." };
    // The manifest lives inside the repository, so its contents may have been tampered
    // with; the restore target must still be inside the root workspace.
    try {
      assertContained(this.rootWorkspace, manifest.workspace);
    } catch {
      return { ok: false, output: "Undo refused: the snapshot manifest points outside the workspace." };
    }
    const currentHead = await gitHead(manifest.workspace);
    if (manifest.preHead !== manifest.postHead || currentHead !== manifest.postHead) {
      return {
        ok: false,
        output: "Undo refused: Git HEAD changed during or after the Agent task. Use Git to recover commits.",
      };
    }
    const currentTree = await captureTree(manifest.workspace);
    const currentEntries = await treeEntries(currentTree, manifest.workspace);
    const postEntries = await treeEntries(manifest.postTree, manifest.workspace);
    const conflicts = manifest.changedPaths.filter((path) => currentEntries.get(path) !== postEntries.get(path));
    if (conflicts.length) {
      await this.updateStatus(manifest, "conflicted");
      return {
        ok: false,
        output: `Undo refused because files changed after the Agent task:\n${conflicts.map((path) => `- ${path}`).join("\n")}`,
      };
    }
    const preEntries = await treeEntries(manifest.preTree, manifest.workspace);
    const unsupported = manifest.changedPaths.filter((path) => !isRestorableEntry(preEntries.get(path)));
    if (unsupported.length) {
      return {
        ok: false,
        output: `Undo refused because the snapshot contains unsupported Git entries:\n${unsupported.map((path) => `- ${path}`).join("\n")}`,
      };
    }
    try {
      for (const path of manifest.changedPaths) {
        await restoreEntry(manifest.workspace, path, preEntries.get(path));
      }
    } catch (error) {
      return {
        ok: false,
        output: `Undo could not complete; the working tree may be partially restored. Inspect it with Git before retrying. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    await this.updateStatus(manifest, "undone", new Date().toISOString());
    return {
      ok: true,
      output: `Undid the latest Agent file change batch (${manifest.taskId}).${describeIgnoredChanges(manifest.ignoredChanges)}`,
    };
  }

  /**
   * Restores the file state from **before** the task `taskId` started.
   *
   * The difference from `undoLatest`: the target is not "the most recent batch" but "some
   * earlier turn", so every Agent change after it must be undone too, and the whole
   * snapshot chain has to be verified as self-consistent first: the same HEAD, every
   * manifest on the chain completed, and the current files still at the chain tail state.
   * If any of that fails, refuse — for the same reason as `undoLatest`: better to let the
   * user investigate with Git than to guess at a state that may only be worse.
   */
  async restoreBefore(sessionId: string, taskId: string): Promise<{ ok: boolean; output: string }> {
    const ascending = [...(await this.list(sessionId))].reverse();
    const index = ascending.findIndex((item) => item.taskId === taskId);
    if (index === -1) {
      return { ok: false, output: `No file snapshot is recorded for that turn (${taskId}).` };
    }
    const chain = ascending.slice(index);
    const target = chain[0]!;
    const paths = [...new Set(chain.flatMap((item) => item.changedPaths))];
    if (paths.length === 0) {
      return { ok: false, output: "That turn did not change any files; nothing to revert." };
    }
    const incomplete = chain.find((item) => item.status === "open" || !item.postTree);
    if (incomplete) {
      return {
        ok: false,
        output: `File rewind refused: the snapshot for turn ${incomplete.taskId} is incomplete. Inspect the working tree with Git first.`,
      };
    }
    try {
      assertContained(this.rootWorkspace, target.workspace);
    } catch {
      return { ok: false, output: "File rewind refused: the snapshot manifest points outside the workspace." };
    }
    const currentHead = await gitHead(target.workspace);
    if (currentHead !== target.preHead || chain.some((item) => item.preHead !== item.postHead)) {
      return {
        ok: false,
        output: "File rewind refused: Git HEAD changed during or after those turns. Use Git to recover commits.",
      };
    }
    for (let position = 0; position < chain.length - 1; position += 1) {
      if (chain[position]!.postTree !== chain[position + 1]!.preTree) {
        return {
          ok: false,
          output: "File rewind refused: the snapshot chain is broken (an intermediate task did not finish).",
        };
      }
    }
    const tail = chain[chain.length - 1]!;
    const currentEntries = await treeEntries(await captureTree(target.workspace), target.workspace);
    const tailEntries = await treeEntries(tail.postTree!, target.workspace);
    const conflicts = paths.filter((path) => currentEntries.get(path) !== tailEntries.get(path));
    if (conflicts.length) {
      for (const item of chain) await this.updateStatus(item, "conflicted");
      return {
        ok: false,
        output: `File rewind refused because files changed after those turns:\n${conflicts.map((path) => `- ${path}`).join("\n")}`,
      };
    }
    const preEntries = await treeEntries(target.preTree, target.workspace);
    const unsupported = paths.filter((path) => !isRestorableEntry(preEntries.get(path)));
    if (unsupported.length) {
      return {
        ok: false,
        output: `File rewind refused because the snapshot contains unsupported Git entries:\n${unsupported.map((path) => `- ${path}`).join("\n")}`,
      };
    }
    try {
      for (const path of paths) {
        await restoreEntry(target.workspace, path, preEntries.get(path));
      }
    } catch (error) {
      return {
        ok: false,
        output: `File rewind could not complete; the working tree may be partially restored. Inspect it with Git before retrying. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const undoneAt = new Date().toISOString();
    for (const item of chain) await this.updateStatus(item, "undone", undoneAt);
    return {
      ok: true,
      output: [
        `Reverted ${paths.length} file(s) to the state before turn ${taskId}:`,
        ...paths.map((path) => `- ${path}`),
        // Every snapshot in the chain, since the rewind undoes all of them.
        describeIgnoredChanges([...new Set(chain.flatMap((item) => item.ignoredChanges ?? []))]),
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    };
  }

  private async updateStatus(manifest: SnapshotManifest, status: SnapshotStatus, undoneAt?: string): Promise<void> {
    await writeJsonAtomic(this.manifestPath(manifest.sessionId, manifest.taskId), {
      ...manifest,
      status,
      ...(undoneAt ? { undoneAt } : {}),
    } satisfies SnapshotManifest);
  }

  private manifestPath(sessionId: string, taskId: string): string {
    return resolve(projectStateRoot(this.rootWorkspace), "snapshots", safePart(sessionId), `${safePart(taskId)}.json`);
  }

  private async findManifestPath(taskId: string, sessionNames: readonly string[]): Promise<string | undefined> {
    for (const session of sessionNames) {
      const candidate = this.manifestPath(session, taskId);
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }
}

async function captureTree(workspace: string): Promise<string> {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "oran-snapshot-"));
  const indexPath = resolve(temporaryRoot, "index");
  try {
    await git(workspace, ["read-tree", "--empty"], indexPath);
    await git(
      workspace,
      ["add", "-A", "--", ".", ...PROJECT_STATE_DIR_NAMES.map((name) => `:(exclude)${name}`)],
      indexPath,
    );
    const result = await git(workspace, ["write-tree"], indexPath);
    return result.stdout.trim();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function git(
  workspace: string,
  args: readonly string[],
  indexPath?: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : process.env,
  });
}

async function gitBuffer(workspace: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", workspace, ...args], { encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

/** Paths git ignores that were modified since the task started (see SnapshotManifest.ignoredChanges). */
async function ignoredPathsChangedSince(workspace: string, since: string): Promise<string[]> {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return [];
  let stdout: string;
  try {
    // matching: an ignored directory is one entry, not a walk into it.
    stdout = (await git(workspace, ["status", "--porcelain", "--ignored=matching"])).stdout;
  } catch {
    return []; // not a repository, or git refused: nothing to report
  }
  const changed: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("!! ")) continue;
    const path = line.slice(3).trim().replace(/\/$/, "");
    if (!path) continue;
    // The snapshot store itself lives here, under a state directory git ignores, and
    // this function runs after it has written.
    if (PROJECT_STATE_DIR_NAMES.some((name) => path.split("/").includes(name))) continue;
    try {
      if ((await lstat(resolve(workspace, path))).mtimeMs >= cutoff) changed.push(path);
    } catch {
      // Removed since: nothing to restore and nothing to warn about.
    }
  }
  return changed.sort();
}

/** The sentence undo appends when a batch touched files git does not track. */
function describeIgnoredChanges(paths: readonly string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? `, and ${paths.length - 3} more` : "";
  return ` ${paths.length} path(s) git ignores changed during this task and were left as they are: ${shown}${more}.`;
}

async function gitHead(workspace: string): Promise<string> {
  try {
    return (await git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
  } catch {
    return "";
  }
}

async function treeEntries(tree: string, workspace: string): Promise<Map<string, string>> {
  const result = await git(workspace, ["ls-tree", "-r", "-z", tree]);
  const entries = new Map<string, string>();
  for (const item of result.stdout.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    if (tab < 0) continue;
    const metadata = item.slice(0, tab).split(" ");
    const path = item.slice(tab + 1);
    if (metadata.length >= 3) entries.set(path, `${metadata[0]} ${metadata[1]} ${metadata[2]}`);
  }
  return entries;
}

async function restoreEntry(workspace: string, path: string, entry: string | undefined): Promise<void> {
  const target = resolve(workspace, path);
  assertContained(workspace, target);
  await rm(target, { recursive: true, force: true });
  if (!entry) return;
  const [mode, type, oid] = entry.split(" ");
  if (!mode || type !== "blob" || !oid) throw new Error(`invalid snapshot tree entry for ${path}`);
  const content = await gitBuffer(workspace, ["cat-file", "blob", oid]);
  await mkdir(dirname(target), { recursive: true });
  if (mode === "120000") {
    try {
      await symlink(content.toString("utf8"), target);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await writeFile(target, content);
    }
  } else {
    await writeFile(target, content);
    if (mode === "100755") await chmod(target, 0o755);
  }
}

function isRestorableEntry(entry: string | undefined): boolean {
  if (!entry) return true;
  const [mode, type, oid] = entry.split(" ");
  return type === "blob" && Boolean(oid) && (mode === "100644" || mode === "100755" || mode === "120000");
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`snapshot path escapes workspace: ${target}`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await (await import("node:fs/promises")).rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
