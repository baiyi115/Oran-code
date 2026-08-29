import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const PRODUCT_NAME = "Oran code";
export const PRODUCT_VERSION = "0.1.0";
export const CLI_NAME = "oran";
export const CLIENT_ID = "oran-code/cli";
export const CLIENT_USER_AGENT = `oran-code/${PRODUCT_VERSION} (cli)`;
export const PROJECT_STATE_DIRECTORY = ".oran";
export const LEGACY_PROJECT_STATE_DIRECTORY = ".litecode";
/** 历史遗留的项目级配置目录名(仅 config.ts 兼容读取,不参与目录迁移)。 */
export const LEGACY_PROJECT_CONFIG_DIRECTORY = ".liteagent";
export const USER_DATA_DIRECTORY = ".oran";
export const LEGACY_USER_DATA_DIRECTORY = ".liteagent";

/** 项目状态目录与历史遗留目录名;搜索、快照、指纹的排除逻辑共用同一来源。 */
export const PROJECT_STATE_DIR_NAMES: readonly string[] = [
  PROJECT_STATE_DIRECTORY,
  LEGACY_PROJECT_STATE_DIRECTORY,
  LEGACY_PROJECT_CONFIG_DIRECTORY,
];

/** Oran always writes project state to .oran. */
export function projectStateRoot(workspace: string): string {
  return resolve(workspace, PROJECT_STATE_DIRECTORY);
}

/**
 * Move legacy .litecode project state into .oran before any store is opened.
 * Existing .oran files win; conflicting legacy files are retained under
 * .oran/legacy-litecode instead of being overwritten or discarded.
 */
export async function ensureProjectStateRoot(workspace: string): Promise<string> {
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

/**
 * Move the project-scoped sessions/trace.db/memory from <workspace>/.oran into
 * ~/.oran once, so user data stops polluting the worktree. Conflicts are
 * archived under the destination rather than overwritten.
 */
export async function migrateUserDataOutOfWorkspace(workspace: string): Promise<void> {
  const projectRoot = projectStateRoot(workspace);
  const moves: Array<[source: string, destination: string]> = [
    [resolve(projectRoot, "sessions"), userSessionsRoot(workspace)],
    [resolve(projectRoot, "trace.db"), resolve(userTraceRoot(workspace), "trace.db")],
    [resolve(projectRoot, "memory"), userMemoryRoot(workspace)],
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
