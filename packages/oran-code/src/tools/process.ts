import { exec, execFile, spawn } from "node:child_process";
import { resolvePhysicalPath, isWithinPath } from "../utils/path-containment.js";
import { resolveWorkspacePath } from "./fs-helpers.js";

/** Output ceiling kept for one command/job: past it the head and tail are kept and the middle dropped. */
const COMMAND_OUTPUT_LIMIT = 200_000;
const COMMAND_OUTPUT_HEAD = 96_000;
const COMMAND_OUTPUT_TAIL = 96_000;

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

/** Result of one command execution: a non-zero exit code or signal termination is not an
 * exception; the caller decides how to treat it. */
export interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Error when the spawn phase fails (e.g. the working directory does not exist). */
  spawnError?: string;
}

/**
 * Handle to an already-started command.
 * Differs from a one-shot `exec`: **output accumulates as a stream throughout and a timeout does
 * not kill the process**, so the caller can promote it to a background job after a timeout and
 * keep reaping it.
 */
export interface RunningCommand {
  readonly pid: number | undefined;
  /** Resolves once the process exits (or is killed). */
  readonly exited: Promise<CommandOutcome>;
  /** Current snapshot of the accumulated output; safe to call while the process is still running. */
  snapshot(): CommandOutcome;
  /** Whether the process has already exited. */
  readonly finished: boolean;
  kill(): void;
}

/** Output buffer: past the ceiling the head and tail are kept while the middle is dropped and
 * counted, so a long-running task cannot blow up memory. */
class OutputCollector {
  private buffer = "";
  private head: string | undefined;
  private tail = "";
  private dropped = 0;

  append(text: string): void {
    if (this.head === undefined) {
      this.buffer += text;
      if (this.buffer.length > COMMAND_OUTPUT_LIMIT) {
        this.head = this.buffer.slice(0, COMMAND_OUTPUT_HEAD);
        this.tail = this.buffer.slice(-COMMAND_OUTPUT_TAIL);
        this.dropped = Math.max(0, this.buffer.length - this.head.length - this.tail.length);
        this.buffer = "";
      }
      return;
    }
    this.dropped += text.length;
    const combined = this.tail + text;
    this.tail = combined.length > COMMAND_OUTPUT_TAIL ? combined.slice(-COMMAND_OUTPUT_TAIL) : combined;
  }

  value(): string {
    if (this.head === undefined) return this.buffer;
    return `${this.head}\n...[${this.dropped} characters omitted from the middle of this output]...\n${this.tail}`;
  }
}

/**
 * Start a command and keep accumulating its output.
 * On POSIX an independent process group (detached) is used so that `killProcessTree`'s `-pid`
 * can really kill the whole tree; on Windows `taskkill /T` handles tree cleanup, so detached is
 * not needed.
 */
export function startCommand(
  command: string,
  options: { cwd: string; signal?: AbortSignal | undefined },
): RunningCommand {
  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = new OutputCollector();
  const stderr = new OutputCollector();
  let finished = false;
  let onAbort: (() => void) | undefined;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderr.append(chunk));

  const pid = child.pid;
  const kill = (): void => killProcessTree(pid);
  let settledOutcome: CommandOutcome | undefined;
  const snapshot = (): CommandOutcome =>
    settledOutcome ?? { stdout: stdout.value(), stderr: stderr.value(), exitCode: null, signal: null };

  const exited = new Promise<CommandOutcome>((resolvePromise) => {
    let settled = false;
    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      finished = true;
      settledOutcome = outcome;
      if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    };
    child.once("close", (code, signal) => {
      settle({ stdout: stdout.value(), stderr: stderr.value(), exitCode: code, signal });
    });
    child.once("error", (error) => {
      settle({
        stdout: stdout.value(),
        stderr: stderr.value(),
        exitCode: null,
        signal: null,
        spawnError: error.message,
      });
    });
  });

  if (options.signal) {
    onAbort = (): void => kill();
    if (options.signal.aborted) kill();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    pid,
    exited,
    snapshot,
    get finished(): boolean {
      return finished;
    },
    kill,
  };
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

/** Resolve run_command's optional cwd: two-layer protection through lexical and physical (symlink) containment. */
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
