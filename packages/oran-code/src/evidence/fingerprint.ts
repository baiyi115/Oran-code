import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, open } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { userDataRoot } from "../paths.js";
import { isWithinPath, resolvePhysicalPath } from "../utils/path-containment.js";
import type { SourceFingerprint } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_MS = 6_000;
const EXCLUDED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);
const RUNTIME = new Set([
  "evidence",
  "progress",
  "checkpoints",
  "snapshots",
  "sessions",
  "graph",
  "debug",
  "worktrees",
]);

/** Versioned, bounded content sampling. It deliberately does not write Git objects or an index. */
export async function fingerprintSource(workspace: string): Promise<SourceFingerprint> {
  const root = resolve(workspace);
  const deadline = Date.now() + MAX_DURATION_MS;
  const limitations = new Set<string>(["sample_only", "ignored_untracked_files_excluded", "artifact_exclusions_v1"]);
  let complete = true;
  let paths: string[] = [];
  const trackedPaths = new Set<string>();
  const userRoot = await resolvePhysicalPath(userDataRoot());
  const physicalRoot = await resolvePhysicalPath(root);
  const invalidate = (reason: string): void => {
    complete = false;
    limitations.add(reason);
  };
  const excluded = (path: string): boolean => {
    const parts = path.split("/");
    if (parts.includes(".git")) return true;
    if (!trackedPaths.has(path) && parts.some((part) => EXCLUDED.has(part))) return true;
    return parts.some(
      (part, i) => [".oran", ".litecode", ".liteagent"].includes(part) && RUNTIME.has(parts[i + 1] ?? ""),
    );
  };
  try {
    const result = await execFileAsync(
      "git",
      ["--no-optional-locks", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    paths = result.stdout.split("\0").filter(Boolean);
    const tracked = await execFileAsync("git", ["--no-optional-locks", "-C", root, "ls-files", "--cached", "-z"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    for (const path of tracked.stdout.split("\0").filter(Boolean)) trackedPaths.add(path);
    // Project-authored Oran configuration can be ignored by Git but still changes execution.
    let configEntries = 0;
    const configWalk = async (directory: string): Promise<void> => {
      if (Date.now() > deadline || configEntries >= MAX_FILES) {
        invalidate("configuration_enumeration_limit");
        return;
      }
      const physical = await resolvePhysicalPath(directory);
      if (!physical || !physicalRoot || !isWithinPath(physicalRoot, physical)) {
        invalidate("configuration_path_unavailable");
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") invalidate("configuration_unavailable");
        return [];
      });
      for (const entry of entries) {
        if (Date.now() > deadline || configEntries++ >= MAX_FILES) {
          invalidate("configuration_enumeration_limit");
          return;
        }
        const full = resolve(directory, entry.name);
        const path = relative(root, full).replaceAll("\\", "/");
        if (excluded(path)) continue;
        if (entry.isDirectory()) await configWalk(full);
        else paths.push(path);
      }
    };
    for (const name of [".oran", ".litecode", ".liteagent"]) await configWalk(resolve(root, name));
    limitations.add("project_configuration_included");
  } catch {
    limitations.delete("ignored_untracked_files_excluded");
    limitations.add("filesystem_scope_without_gitignore");
    const walk = async (directory: string): Promise<void> => {
      if (Date.now() > deadline || paths.length >= MAX_FILES) {
        invalidate("enumeration_limit");
        return;
      }
      const physical = await resolvePhysicalPath(directory);
      if (!physical || !physicalRoot || !isWithinPath(physicalRoot, physical)) {
        invalidate("enumeration_path_unavailable");
        return;
      }
      let childrenCount = 0;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        invalidate("enumeration_unavailable");
        return;
      }
      for (const entry of entries) {
        if (Date.now() > deadline || paths.length >= MAX_FILES || childrenCount++ >= MAX_FILES) {
          invalidate("enumeration_limit");
          return;
        }
        const full = resolve(directory, entry.name);
        const path = relative(root, full).replaceAll("\\", "/");
        if (excluded(path)) continue;
        if (userRoot && isWithinPath(userRoot, full)) continue;
        if (entry.isDirectory()) await walk(full);
        else paths.push(path);
      }
    };
    await walk(root);
  }
  const digest = createHash("sha256").update("oran-source-policy/1\0");
  let bytes = 0;
  let fileCount = 0;
  for (const path of [...new Set(paths)].sort()) {
    if (excluded(path)) continue;
    if (Date.now() > deadline || fileCount >= MAX_FILES) {
      invalidate("fingerprint_limit");
      break;
    }
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
      invalidate("path_outside_workspace");
      continue;
    }
    try {
      const physical = await resolvePhysicalPath(target);
      if (!physical || !physicalRoot || !isWithinPath(physicalRoot, physical)) {
        invalidate("path_resolution_unavailable");
        continue;
      }
      if (userRoot && isWithinPath(userRoot, physical)) {
        limitations.add("user_runtime_excluded");
        continue;
      }
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) {
        invalidate("unsupported_file_kind");
        continue;
      }
      if (info.size > MAX_FILE_BYTES || bytes + info.size > MAX_TOTAL_BYTES) {
        invalidate("content_size_limit");
        continue;
      }
      const file = await open(target, "r");
      try {
        const before = await file.stat();
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let readBytes = 0;
        while (true) {
          const read = await file.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          readBytes += read.bytesRead;
          bytes += read.bytesRead;
          if (readBytes > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES || Date.now() > deadline) {
            invalidate("content_read_limit");
            break;
          }
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await file.stat();
        const current = await lstat(target);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          current.ino !== after.ino ||
          current.ctimeMs !== after.ctimeMs
        )
          invalidate("changed_during_sampling");
        digest
          .update(path)
          .update("\0")
          .update(String(after.mode))
          .update("\0")
          .update(hash.digest("hex"))
          .update("\n");
        fileCount++;
      } finally {
        await file.close();
      }
    } catch (error) {
      // Tracked deletions are a stable part of the sampled working tree.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") digest.update(path).update("\0missing\n");
      else invalidate("content_unavailable");
    }
  }
  return {
    policyVersion: 1,
    digest: digest.digest("hex"),
    complete,
    fileCount,
    capturedAt: new Date().toISOString(),
    scope: "tracked_and_nonignored_files_plus_project_configuration;artifact_exclusions_v1",
    limitations: [...limitations],
  };
}
