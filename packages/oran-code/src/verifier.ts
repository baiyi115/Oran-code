import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VerificationResult } from "./types.js";

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

  static inferCommands(workspace: string): string[] {
    const commands: string[] = [];
    if (existsSync(join(workspace, "pyproject.toml"))) commands.push(findPython(workspace));
    if (existsSync(join(workspace, "package.json"))) commands.push("npm test");
    if (existsSync(join(workspace, "go.mod"))) commands.push("go test ./...");
    if (existsSync(join(workspace, "pom.xml"))) commands.push("mvn -q test");
    return commands;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function findPython(workspace: string): string {
  const candidates = process.platform === "win32"
    ? [join(workspace, ".venv", "Scripts", "python.exe"), join(workspace, "venv", "Scripts", "python.exe")]
    : [join(workspace, ".venv", "bin", "python"), join(workspace, "venv", "bin", "python")];
  return `"${candidates.find(existsSync) ?? process.execPath}" -m pytest -q`;
}
