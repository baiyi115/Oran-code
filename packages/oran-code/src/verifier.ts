import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationResult } from "./types.js";
import { isAbortError } from "./utils/abort-error.js";

const execAsync = promisify(exec);

export class Verifier {
  constructor(private readonly workspace: string, private readonly timeoutMs = 120_000) {}

  async run(command: string, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<VerificationResult> {
    const started = Date.now();
    if (signal?.aborted) throw new DOMException("operation aborted", "AbortError");
    try {
      const result = await execAsync(command, { cwd: this.workspace, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) });
      if (signal?.aborted) throw new DOMException("operation aborted", "AbortError");
      return { command, exitCode: 0, output: `${result.stdout}${result.stderr}`.slice(-32_000), durationMs: Date.now() - started, passed: true };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new DOMException("operation aborted", "AbortError");
      const item = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
      const timedOut = item.killed === true;
      return { command, exitCode: timedOut ? -1 : Number(item.code ?? 1), output: `${item.stdout ?? ""}${item.stderr ?? ""}`.slice(-32_000) || (timedOut ? `verification timed out after ${timeoutMs}ms` : "verification failed"), durationMs: Date.now() - started, passed: false };
    }
  }

  async runMany(commands: string[], signal?: AbortSignal): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const command of commands) {
      results.push(await this.run(command, this.timeoutMs, signal));
      if (!results.at(-1)?.passed) break;
    }
    return results;
  }

  /**
   * Infer verification commands from the workspace layout.
   *
   * Node projects resolve the package.json `scripts.test` entry through the
   * project's own package manager (pnpm when the workspace is a pnpm
   * workspace, otherwise npm), so monorepos and projects with custom test
   * scripts are verified correctly. A package.json without a test script does
   * not produce a Node command, so verification never fails with a spurious
   * "missing script" error.
   */
  static inferCommands(workspace: string): string[] {
    const commands: string[] = [];
    const nodeCommand = inferNodeTestCommand(workspace);
    if (nodeCommand) commands.push(nodeCommand);
    if (existsSync(join(workspace, "pyproject.toml"))) commands.push(findPython(workspace));
    if (existsSync(join(workspace, "go.mod"))) commands.push("go test ./...");
    if (existsSync(join(workspace, "pom.xml"))) commands.push("mvn -q test");
    return commands;
  }
}

function inferNodeTestCommand(workspace: string): string | undefined {
  const packageJsonPath = join(workspace, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const packageJson = readPackageJson(packageJsonPath);
  if (!packageJson) return undefined;
  const rawScripts = packageJson.scripts;
  if (!rawScripts || typeof rawScripts !== "object" || Array.isArray(rawScripts)) return undefined;
  const scripts = rawScripts as Record<string, unknown>;
  if (typeof scripts.test !== "string" || !scripts.test.trim()) return undefined;
  const packageManager = typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  const usesPnpm = existsSync(join(workspace, "pnpm-workspace.yaml")) || packageManager.startsWith("pnpm");
  return usesPnpm ? "pnpm test" : "npm test";
}

function readPackageJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function findPython(workspace: string): string {
  const candidates = process.platform === "win32"
    ? [join(workspace, ".venv", "Scripts", "python.exe"), join(workspace, "venv", "Scripts", "python.exe")]
    : [join(workspace, ".venv", "bin", "python"), join(workspace, "venv", "bin", "python")];
  const fallback = process.platform === "win32" ? "python" : "python3";
  return `"${candidates.find(existsSync) ?? fallback}" -m pytest -q`;
}
