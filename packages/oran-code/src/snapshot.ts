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
  readonly status: SnapshotStatus;
  readonly undoneAt?: string;
}

export interface SnapshotStorePort {
  begin(sessionId: string, task: Task): Promise<void>;
  finalize(task: Task): Promise<void>;
  undoLatest(sessionId: string): Promise<{ ok: boolean; output: string }>;
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
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      completedAt: new Date().toISOString(),
      postTree,
      postHead,
      changedPaths,
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
    return { ok: true, output: `Undid the latest Agent file change batch (${manifest.taskId}).` };
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
