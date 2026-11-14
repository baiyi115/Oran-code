import { randomUUID } from "node:crypto";
import type { CommandEvidenceHandle } from "../evidence/types.js";
import type { SandboxPolicy } from "../types.js";
import { formatPreservingTail, startCommand, type CommandOutcome, type RunningCommand } from "./process.js";

export type ShellJobStatus = "running" | "exited" | "failed" | "killed";

/** Snapshot of a background job: tool output, notifications, and the TUI list are all rendered from it. */
export interface ShellJobSnapshot {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  status: ShellJobStatus;
  endedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
  commandEvidence?: import("../evidence/types.js").EvidenceRecord;
  outputTruncated?: boolean;
}

const NOTIFICATION_OUTPUT_LIMIT = 8_000;

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** Job lifecycle notification text: injected by the session before the next request or when the task wraps up. */
export function shellJobNotification(job: ShellJobSnapshot): string {
  const combined = `${job.stdout}${job.stderr}`;
  const output =
    combined.length > NOTIFICATION_OUTPUT_LIMIT
      ? `${combined.slice(0, NOTIFICATION_OUTPUT_LIMIT)}\n...[truncated ${combined.length - NOTIFICATION_OUTPUT_LIMIT} chars]`
      : combined;
  return [
    "<job-notification>",
    `Background job ${job.id} ("${escapeAttribute(job.command)}"): ${describeJobStatus(job)}`,
    `Output: ${output || "(no output yet)"}`,
    "</job-notification>",
  ].join("\n");
}

export function describeJobStatus(job: ShellJobSnapshot): string {
  if (job.status === "running") return "running";
  if (job.status === "killed") return "killed";
  if (job.error) return `failed: ${job.error}`;
  if (job.signal) return `terminated by ${job.signal}`;
  return `exited with code ${String(job.exitCode ?? "unknown")}`;
}

class ShellJob {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt = new Date().toISOString();
  readonly running: RunningCommand;
  notified = false;
  status: ShellJobStatus = "running";
  endedAt: string | undefined;
  private lastOutcome: CommandOutcome | undefined;
  private failureReason: string | undefined;
  private readonly completion: Promise<void>;
  private readonly evidence: CommandEvidenceHandle | undefined;

  constructor(options: {
    id: string;
    command: string;
    cwd: string;
    running: RunningCommand;
    promoted?: boolean;
    evidence?: CommandEvidenceHandle;
  }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.running = options.running;
    this.evidence = options.evidence;
    this.completion = this.running.exited.then(async (outcome) => {
      this.lastOutcome = outcome;
      this.endedAt = new Date().toISOString();
      const cancelled = this.status === "killed" || outcome.cancelled === true;
      if (this.status !== "killed") {
        this.status = outcome.spawnError || outcome.exitCode !== 0 ? "failed" : "exited";
        this.failureReason = outcome.spawnError;
      }
      await this.evidence?.complete({ ...outcome, cancelled });
    });
  }

  /** Resolves only once the job settles (exited or killed); backs the wait_seconds semantics. */
  settled(): Promise<void> {
    return this.completion;
  }

  markKilled(): void {
    this.status = "killed";
    this.endedAt = new Date().toISOString();
  }

  snapshot(): ShellJobSnapshot {
    const outcome = this.lastOutcome;
    return {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      startedAt: this.startedAt,
      status: this.status,
      exitCode: outcome?.exitCode ?? null,
      signal: this.running.finished ? (outcome?.signal ?? null) : null,
      stdout: this.running.snapshot().stdout,
      stderr: this.running.snapshot().stderr,
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.failureReason ? { error: this.failureReason } : {}),
      ...(this.evidence ? { commandEvidence: this.evidence.receipt() } : {}),
      outputTruncated: this.running.snapshot().outputTruncated === true,
    };
  }
}

/**
 * In-process background job table.
 *
 * Parallel to `BackgroundAgentTaskManager` (the subagent pool): shell jobs live only in the
 * current process and are not persisted across restarts (once the process is gone, child
 * processes are meaningless anyway); they are all cleaned up on process exit.
 */
export class ShellJobManager {
  private readonly jobs = new Map<string, ShellJob>();
  private nextId = 1;

  start(options: {
    command: string;
    cwd: string;
    signal?: AbortSignal | undefined;
    sandbox?: SandboxPolicy | undefined;
    evidence?: CommandEvidenceHandle;
  }): ShellJobSnapshot {
    const running = startCommand(options.command, {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    });
    return this.track({
      command: options.command,
      cwd: options.cwd,
      running,
      ...(options.evidence ? { evidence: options.evidence } : {}),
    });
  }

  /**
   * Timeout promotion: a foreground command is not killed at the deadline but adopted as a
   * background job (output and handle preserved as-is).
   */
  adopt(options: {
    command: string;
    cwd: string;
    running: RunningCommand;
    evidence?: CommandEvidenceHandle;
  }): ShellJobSnapshot {
    return this.track(options);
  }

  private track(options: {
    command: string;
    cwd: string;
    running: RunningCommand;
    evidence?: CommandEvidenceHandle;
  }): ShellJobSnapshot {
    const id = `job-${this.nextId++}-${randomUUID().slice(0, 6)}`;
    const job = new ShellJob({ id, ...options });
    this.jobs.set(id, job);
    return job.snapshot();
  }

  get(id: string): ShellJobSnapshot | undefined {
    return this.jobs.get(id)?.snapshot();
  }

  list(): ShellJobSnapshot[] {
    return [...this.jobs.values()].map((job) => job.snapshot());
  }

  /** Wait for the job to settle; with `waitMs` of 0 this only takes a single snapshot. */
  async wait(id: string, waitMs: number): Promise<ShellJobSnapshot | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (waitMs > 0 && !job.running.finished) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        job.settled(),
        new Promise<void>((resolveWait) => {
          timer = setTimeout(resolveWait, waitMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return job.snapshot();
  }

  kill(id: string): ShellJobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!job.running.finished) {
      job.markKilled();
      job.running.kill();
    }
    return job.snapshot();
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.running.finished) continue;
      job.markKilled();
      job.running.kill();
    }
  }

  /** Take the terminal jobs not yet notified (each job is notified only once). */
  drainNotifications(): ShellJobSnapshot[] {
    const notifications: ShellJobSnapshot[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.notified) continue;
      job.notified = true;
      notifications.push(job.snapshot());
    }
    return notifications;
  }

  /** Returns the list while jobs are still running (for displays such as /status). */
  running(): ShellJobSnapshot[] {
    return this.list().filter((job) => job.status === "running");
  }
}

/** Job summary inside tool output: reuses formatPreservingTail's head/tail retention strategy. */
export function formatJobOutput(job: ShellJobSnapshot, maxChars = 16_000): string {
  const combined = formatPreservingTail(`${job.stdout}${job.stderr}`, maxChars);
  return [
    `<job-output id="${job.id}" status="${job.status}">`,
    `Command: ${job.command}`,
    `Status: ${describeJobStatus(job)}`,
    ...(job.cwd ? [`Working directory: ${job.cwd}`] : []),
    "Output:",
    combined || "(no output yet)",
    "</job-output>",
  ].join("\n");
}

let defaultManager: ShellJobManager | undefined;

/**
 * Process-level default job table.
 * The tool registry is rebuilt several times within a session (once each for cli/agent/session
 * and TUI commands), and jobs must survive those registry instances, so the default instance
 * hangs off the process rather than off a registry.
 */
export function shellJobs(): ShellJobManager {
  if (!defaultManager) {
    defaultManager = new ShellJobManager();
    process.once("exit", () => defaultManager?.killAll());
  }
  return defaultManager;
}
