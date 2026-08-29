import { exec, execFile } from "node:child_process";
import { resolvePhysicalPath, isWithinPath } from "../utils/path-containment.js";
import { resolveWorkspacePath } from "./fs-helpers.js";

export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

export function formatPreservingTail(output: string, maxChars = 32_000, headChars = 8_000): string {
  if (!output || output.length <= maxChars) return output;
  const separator = `\n\n... [truncated ${output.length - maxChars} characters, showing head and tail] ...\n\n`;
  const available = Math.max(0, maxChars - separator.length);
  const headLen = Math.min(headChars, Math.floor(available / 3));
  const tailLen = available - headLen;
  return `${output.slice(0, headLen)}${separator}${output.slice(output.length - tailLen)}`;
}

export function executeCommandWithProcessTree(
  command: string,
  options: { cwd: string; timeout: number; signal?: AbortSignal | undefined },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const child = exec(
      command,
      {
        cwd: options.cwd,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        if (timedOut) {
          const timeoutErr = Object.assign(new Error("command timed out"), {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            killed: true,
            cmd: command,
          });
          return reject(timeoutErr);
        }
        if (error) {
          const runErr = Object.assign(error, {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            cmd: command,
          });
          return reject(runErr);
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );

    const childPid = child.pid;

    const onAbort = () => {
      killProcessTree(childPid);
      reject(new DOMException("operation aborted", "AbortError"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        killProcessTree(childPid);
        return reject(new DOMException("operation aborted", "AbortError"));
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(childPid);
      }, options.timeout);
      timer.unref?.();
    }
  });
}

/** 解析 run_command 的可选 cwd：词法包含 + symlink 物理包含双重防护。 */
export async function resolveCommandCwd(root: string, raw: unknown): Promise<string> {
  if (raw === undefined || raw === null || raw === "") return root;
  if (typeof raw !== "string") throw new Error("cwd must be a string path relative to the workspace root");
  const candidate = resolveWorkspacePath(root, raw);
  const [physicalRoot, physicalCandidate] = await Promise.all([
    resolvePhysicalPath(root),
    resolvePhysicalPath(candidate),
  ]);
  if (!physicalRoot || !physicalCandidate) throw new Error(`cwd could not be resolved safely: ${String(raw)}`);
  if (!isWithinPath(physicalRoot, physicalCandidate)) {
    throw new Error(`cwd escapes workspace through a symbolic link: ${String(raw)}`);
  }
  return candidate;
}

export function getWindowsCommandDiagnostic(cmd: string, output: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const hints: string[] = [];
  const trimmedCmd = cmd.trim();

  if (trimmedCmd.includes("'")) {
    hints.push(
      "Windows cmd.exe does not treat single quotes ('') as quote delimiters. Use double quotes (\"\") for arguments and strings.",
    );
  }

  const unixToolMapping: Record<string, string> = {
    grep: "search_code",
    rg: "search_code",
    findstr: "search_code",
    cat: "read_file",
    head: "read_file",
    tail: "read_file",
    ls: "list_files",
    dir: "list_files",
    find: "list_files",
    sed: "edit_file or apply_patch",
    awk: "edit_file",
    rm: "dedicated file operations",
    cp: "dedicated file operations",
    mv: "dedicated file operations",
    touch: "write_file",
  };

  const firstWord = trimmedCmd.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (unixToolMapping[firstWord]) {
    hints.push(
      `Command '${firstWord}' failed or may be unavailable on Windows. Prefer the native agent tool: ${unixToolMapping[firstWord]}.`,
    );
  }

  if (
    /is not recognized as an internal or external command/i.test(output) ||
    /The term .* is not recognized/i.test(output)
  ) {
    if (!hints.some((h) => h.includes("native agent tool"))) {
      hints.push(
        "If you are trying to read, search, or edit files, use dedicated agent tools (read_file, search_code, list_files, edit_file) instead of shell utilities.",
      );
    }
  }

  if (hints.length === 0) return undefined;
  return `\n[Windows Diagnostic Hint]\n${hints.map((h) => `• ${h}`).join("\n")}`;
}
