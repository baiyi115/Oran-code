import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { workspaceDataPath } from "../paths.js";
import { isWithinPath, resolvePhysicalPath } from "../utils/path-containment.js";

export function attemptDirectory(workspace: string, taskId: string, attemptId: string): string {
  for (const part of [taskId, attemptId]) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(part)) throw new Error("Invalid evidence identity");
  }
  return workspaceDataPath(workspace, "evidence", taskId, attemptId);
}

/** Validate physical containment before writing, including existing symlink ancestors. */
export async function controlledPath(
  workspace: string,
  taskId: string,
  attemptId: string,
  name: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(name) || name === "." || name === "..") {
    throw new Error("Invalid evidence artifact name");
  }
  const root = workspaceDataPath(workspace, "evidence");
  const directory = attemptDirectory(workspace, taskId, attemptId);
  const physicalWorkspaceRoot = await resolvePhysicalPath(workspaceDataPath(workspace));
  const physicalRoot = await resolvePhysicalPath(root);
  const physicalDirectory = await resolvePhysicalPath(directory);
  const target = resolve(directory, name);
  const physicalTarget = await resolvePhysicalPath(target);
  if (
    !physicalWorkspaceRoot ||
    !physicalRoot ||
    !physicalDirectory ||
    !physicalTarget ||
    !isWithinPath(physicalWorkspaceRoot, physicalRoot) ||
    !isWithinPath(physicalRoot, physicalDirectory) ||
    !isWithinPath(physicalDirectory, physicalTarget)
  ) {
    throw new Error("Evidence artifact escapes its controlled directory");
  }
  return target;
}

export async function writeArtifact(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(content, "utf8");
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
