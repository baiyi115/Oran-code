import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const PRODUCT_NAME = "Oran code";
export const PRODUCT_VERSION = "0.1.0";
export const CLI_NAME = "oran";
export const CLIENT_ID = "oran-code/cli";
export const CLIENT_USER_AGENT = `oran-code/${PRODUCT_VERSION} (cli)`;
export const PROJECT_STATE_DIRECTORY = ".oran";
export const LEGACY_PROJECT_STATE_DIRECTORY = ".litecode";
/** Legacy project-level config directory name (read for compatibility by config.ts only; it
 * does not participate in directory migration). */
export const LEGACY_PROJECT_CONFIG_DIRECTORY = ".liteagent";
export const USER_DATA_DIRECTORY = ".oran";
export const LEGACY_USER_DATA_DIRECTORY = ".liteagent";

/** The project state directory and the legacy directory names; the search, snapshot and
 * fingerprint exclusion logic all draw on this single source. */
export const PROJECT_STATE_DIR_NAMES: readonly string[] = [
  PROJECT_STATE_DIRECTORY,
  LEGACY_PROJECT_STATE_DIRECTORY,
  LEGACY_PROJECT_CONFIG_DIRECTORY,
];

/**
 * Where a workspace keeps the configuration a human authors: config.json, hooks, saved permission
 * rules, custom subagents, skills, commands and plans. Runtime state (checkpoints, sessions,
 * snapshots, caches, debug logs) lives under userWorkspaceRoot instead, so running Oran in a
 * repository does not add an untracked directory to it.
 */
export function projectStateRoot(workspace: string): string {
  return resolve(workspace, PROJECT_STATE_DIRECTORY);
}

/**
 * Move legacy .litecode project state into .oran before any store is opened.
 * Existing .oran files win; conflicting legacy files are retained under
 * .oran/legacy-litecode instead of being overwritten or discarded.
 */
export async function migrateLegacyProjectState(workspace: string): Promise<string> {
  const preferred = projectStateRoot(workspace);
  const legacy = resolve(workspace, LEGACY_PROJECT_STATE_DIRECTORY);
  if (!existsSync(legacy)) return preferred;

  try {
    if (!existsSync(preferred)) {
      try {
        await rename(legacy, preferred);
        return preferred;
      } catch (error) {
        // Another process may have completed the same migration first.
        if (!existsSync(legacy)) return preferred;
        if (errorCode(error) === "EXDEV") {
          await moveAcrossDevices(legacy, preferred);
          return preferred;
        }
        if (!existsSync(preferred)) throw error;
      }
    }

    await mergeLegacyDirectory(legacy, preferred, resolve(preferred, "legacy-litecode"));
    return preferred;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to migrate ${LEGACY_PROJECT_STATE_DIRECTORY} to ${PROJECT_STATE_DIRECTORY}. ` +
        `Close other Oran/Litecode processes and retry. ${detail}`,
      { cause: error },
    );
  }
}

export function userDataRoot(): string {
  const custom = process.env.ORAN_USER_DATA_DIR || process.env.ORAN_DATA_DIR;
  if (custom && custom.trim()) return resolve(custom.trim());
  return resolve(homedir(), USER_DATA_DIRECTORY);
}

/** Stable short hash for a workspace path, used to isolate user-scoped stores. */
export function projectHash(workspace: string): string {
  const normalized = resolve(workspace)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** User-scoped session store root (~/.oran/sessions/<hash>/). */
export function userSessionsRoot(workspace: string): string {
  return resolve(userDataRoot(), "sessions", projectHash(workspace));
}

/** User-scoped trace database root (~/.oran/trace/<hash>/). */
export function userTraceRoot(workspace: string): string {
  return resolve(userDataRoot(), "trace", projectHash(workspace));
}

/** User-scoped project memory root (~/.oran/memory/<hash>/). */
export function userMemoryRoot(workspace: string): string {
  return resolve(userDataRoot(), "memory", projectHash(workspace));
}

/** User-scoped runtime state root for a workspace (~/.oran/workspaces/<hash>/). */
export function userWorkspaceRoot(workspace: string): string {
  return resolve(userDataRoot(), "workspaces", projectHash(workspace));
}

/** Absolute path to one runtime state entry of a workspace, e.g. workspaceDataPath(ws, "graph"). */
export function workspaceDataPath(workspace: string, ...segments: string[]): string {
  return resolve(userWorkspaceRoot(workspace), ...segments);
}

/**
 * One-time migrations a workspace needs before any state store opens: legacy `.litecode`, then
 * moving everything Oran generates out of the worktree. Both steps are idempotent and safe to run
 * concurrently, so every entry point calls this instead of each store guessing.
 */
export async function prepareWorkspaceState(workspace: string): Promise<void> {
  await migrateLegacyProjectState(workspace);
  await migrateStateOutOfWorkspace(workspace);
}

/**
 * Move the project-local state Oran generates (sessions, traces, checkpoints, progress, snapshots,
 * graph cache, debug logs, subagent state, command usage) into ~/.oran once, so a plain run leaves
 * nothing behind in the worktree. Project-authored configuration stays in .oran. Conflicts are
 * archived under the destination rather than overwritten.
 */
export async function migrateStateOutOfWorkspace(workspace: string): Promise<void> {
  // When the workspace is the user home directory (or an ancestor of it), ~/.oran lies
  // inside workspace/.oran, so the migration would become a rename of a directory into
  // itself (EINVAL); the two are the same place, so skip it.
  const userRoot = resolve(userDataRoot());
  const projectRoot = resolve(projectStateRoot(workspace));
  const userRootRelative = relative(projectRoot, userRoot);
  if (!userRootRelative.startsWith("..") && !isAbsolute(userRootRelative)) return;
  const moves: Array<[source: string, destination: string]> = [
    [resolve(projectRoot, "sessions"), userSessionsRoot(workspace)],
    [resolve(projectRoot, "trace.db"), resolve(userTraceRoot(workspace), "trace.db")],
    [resolve(projectRoot, "memory"), userMemoryRoot(workspace)],
    [resolve(projectRoot, "sessions.json"), workspaceDataPath(workspace, "sessions.json")],
    [resolve(projectRoot, "checkpoints"), workspaceDataPath(workspace, "checkpoints")],
    [resolve(projectRoot, "progress"), workspaceDataPath(workspace, "progress")],
    [resolve(projectRoot, "snapshots"), workspaceDataPath(workspace, "snapshots")],
    [resolve(projectRoot, "graph"), workspaceDataPath(workspace, "graph")],
    [resolve(projectRoot, "debug"), workspaceDataPath(workspace, "debug")],
    [resolve(projectRoot, "command-usage.json"), workspaceDataPath(workspace, "command-usage.json")],
    // Subagent definitions (agents/*.md) stay with the project; only their runtime state leaves.
    [resolve(projectRoot, "agents", "state.json"), workspaceDataPath(workspace, "agents", "state.json")],
  ];
  for (const [source, destination] of moves) {
    if (!existsSync(source)) continue;
    await mkdir(dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      const sourceStats = await safeLstat(source);
      const destStats = await safeLstat(destination);
      if (sourceStats?.isDirectory() && destStats?.isDirectory()) {
        await mergeLegacyDirectory(source, destination, resolve(destination, "legacy-project"));
      } else if (sourceStats && !sourceStats.isDirectory()) {
        const archive = await availableArchivePath(`${destination}.legacy-project`);
        await rename(source, archive);
      }
    } else {
      try {
        await rename(source, destination);
      } catch (error) {
        // EXDEV: rename across filesystems (e.g. D: -> C:\Users). Fall back to
        // recursive copy + remove so the source still leaves the worktree.
        if (errorCode(error) === "EXDEV") {
          await moveAcrossDevices(source, destination);
          continue;
        }
        if (!existsSync(source) && existsSync(destination)) continue;
        if (!existsSync(destination)) throw error;
      }
    }
  }
  // .oran should not outlive its own content: once the runtime state has moved, an empty agents/
  // and an empty .oran disappear, leaving the worktree as the user left it.
  await removeDirectoryIfEmpty(resolve(projectRoot, "agents"));
  await removeDirectoryIfEmpty(projectRoot);
}

/** Removes a directory only when nothing is left in it; a populated or missing one is left alone. */
async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // ENOENT: already gone. ENOTEMPTY: still holds configuration a human wrote. Neither is an error.
  }
}

export function legacyUserDataRoot(): string {
  return resolve(homedir(), LEGACY_USER_DATA_DIRECTORY);
}

/** Prefer the Oran path while continuing to use an existing LiteAgent data path. */
export function compatibleUserDataPath(...segments: string[]): string {
  const preferred = resolve(userDataRoot(), ...segments);
  const legacy = resolve(legacyUserDataRoot(), ...segments);
  return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}

async function mergeLegacyDirectory(source: string, destination: string, archiveDestination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    await migrateLegacyEntry(
      resolve(source, entry.name),
      resolve(destination, entry.name),
      resolve(archiveDestination, entry.name),
    );
  }

  try {
    await rmdir(source);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function migrateLegacyEntry(source: string, destination: string, archiveDestination: string): Promise<void> {
  const sourceStats = await safeLstat(source);
  if (!sourceStats) return;
  let destinationStats = await safeLstat(destination);

  if (!destinationStats) {
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (errorCode(error) === "ENOENT" && !existsSync(source)) return;
      if (errorCode(error) === "EXDEV") {
        await moveAcrossDevices(source, destination);
        return;
      }
      destinationStats = await safeLstat(destination);
      if (!destinationStats) throw error;
    }
  }

  if (sourceStats.isDirectory() && destinationStats.isDirectory()) {
    await mergeLegacyDirectory(source, destination, archiveDestination);
    return;
  }

  const preserved = await availableArchivePath(archiveDestination);
  await mkdir(dirname(preserved), { recursive: true });
  try {
    await rename(source, preserved);
  } catch (error) {
    if (errorCode(error) === "EXDEV") {
      await moveAcrossDevices(source, preserved);
    } else {
      throw error;
    }
  }
}

async function availableArchivePath(requested: string): Promise<string> {
  if (!(await safeLstat(requested))) return requested;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${requested}.${suffix}`;
    if (!(await safeLstat(candidate))) return candidate;
  }
}

/**
 * Cross-device fallback for `rename` when EXDEV is raised (source and
 * destination live on different volumes, e.g. a worktree on D: and the
 * user directory on C:). Mirrors `rename` semantics — destination must
 * not exist — by recursively copying then removing the source.
 */
async function moveAcrossDevices(source: string, destination: string): Promise<void> {
  const sourceStats = await safeLstat(source);
  if (!sourceStats) return;
  if (sourceStats.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await moveAcrossDevices(resolve(source, entry.name), resolve(destination, entry.name));
    }
    await rm(source, { recursive: true, force: true });
  } else {
    await mkdir(dirname(destination), { recursive: true });
    if (await safeLstat(destination)) {
      throw new Error(`destination already exists: ${destination}`);
    }
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
