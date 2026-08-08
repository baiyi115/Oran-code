import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const PRODUCT_NAME = "Oran code";
export const PRODUCT_VERSION = "0.1.0";
export const CLI_NAME = "oran";
export const CLIENT_ID = "oran-code/cli";
export const CLIENT_USER_AGENT = `oran-code/${PRODUCT_VERSION} (cli)`;
export const PROJECT_STATE_DIRECTORY = ".oran";
export const LEGACY_PROJECT_STATE_DIRECTORY = ".litecode";
export const USER_DATA_DIRECTORY = ".oran";
export const LEGACY_USER_DATA_DIRECTORY = ".liteagent";

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
        if (!existsSync(preferred)) throw error;
      }
    }

    await mergeLegacyDirectory(legacy, preferred, resolve(preferred, "legacy-litecode"));
    return preferred;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to migrate ${LEGACY_PROJECT_STATE_DIRECTORY} to ${PROJECT_STATE_DIRECTORY}. `
      + `Close other Oran/Litecode processes and retry. ${detail}`,
    );
  }
}

export function userDataRoot(): string {
  return resolve(homedir(), USER_DATA_DIRECTORY);
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
  await rename(source, preserved);
}

async function availableArchivePath(requested: string): Promise<string> {
  if (!await safeLstat(requested)) return requested;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${requested}.${suffix}`;
    if (!await safeLstat(candidate)) return candidate;
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
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
