import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PRODUCT_NAME = "Oran code";
export const CLI_NAME = "oran";
export const PROJECT_STATE_DIRECTORY = ".oran";
export const LEGACY_PROJECT_STATE_DIRECTORY = ".litecode";
export const USER_DATA_DIRECTORY = ".oran";
export const LEGACY_USER_DATA_DIRECTORY = ".liteagent";

const PROJECT_STATE_MARKERS = [
  "sessions",
  "sessions.json",
  "sessions.json.migrated",
  "trace.db",
  "memory",
  "commands",
  "command-usage.json",
  "permissions.yaml",
] as const;

/** New workspaces use .oran; existing .litecode state remains readable in place. */
export function projectStateRoot(workspace: string): string {
  const preferred = resolve(workspace, PROJECT_STATE_DIRECTORY);
  const legacy = resolve(workspace, LEGACY_PROJECT_STATE_DIRECTORY);
  if (hasProjectState(preferred) || !existsSync(legacy)) return preferred;
  return legacy;
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

function hasProjectState(directory: string): boolean {
  return PROJECT_STATE_MARKERS.some((marker) => existsSync(resolve(directory, marker)));
}
