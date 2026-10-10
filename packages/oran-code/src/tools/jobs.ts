import { randomUUID } from "node:crypto";
import { formatPreservingTail, startCommand, type CommandOutcome, type RunningCommand } from "./process.js";

export type ShellJobStatus = "running" | "exited" | "failed" | "killed";

/** 后台作业的快照:工具输出、通知与 TUI 列表都基于它渲染。 */
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
}

const NOTIFICATION_OUTPUT_LIMIT = 8_000;

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** 作业生命周期通知文本:由 session 在下轮请求前或任务收尾时注入。 */
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

  constructor(options: { id: string; command: string; cwd: string; running: RunningCommand; promoted?: boolean }) {
    this.id = options.id;
    this.command = options.command;
    this.cwd = options.cwd;
    this.running = options.running;
    this.completion = this.running.exited.then((outcome) => {
      this.lastOutcome = outcome;
      this.endedAt = new Date().toISOString();
      if (this.status === "killed") return;
      if (outcome.spawnError) {
        this.status = "failed";
        this.failureReason = outcome.spawnError;
        return;
      }
      this.status = outcome.exitCode === 0 ? "exited" : "failed";
    });
  }

  /** 作业收尾(退出或被杀)后才 resolve;用于 wait_seconds 语义。 */
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
    };
  }
}

/**
 * 进程内后台作业表。
 *
 * 与 `BackgroundAgentTaskManager`(子代理池)平行:shell 作业只活在当前进程,
 * 不做跨重启持久化(进程都没了,子进程也失去意义),进程退出时统一清理。
 */
export class ShellJobManager {
  private readonly jobs = new Map<string, ShellJob>();
  private nextId = 1;

  start(options: { command: string; cwd: string; signal?: AbortSignal | undefined }): ShellJobSnapshot {
    const running = startCommand(options.command, {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.track({ command: options.command, cwd: options.cwd, running });
  }

  /** 超时晋升:前台命令到点不杀,直接接管为后台作业(输出与句柄原样保留)。 */
  adopt(options: { command: string; cwd: string; running: RunningCommand }): ShellJobSnapshot {
    return this.track(options);
  }

  private track(options: { command: string; cwd: string; running: RunningCommand }): ShellJobSnapshot {
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

  /** 等待作业收尾;`waitMs` 为 0 时只做一次快照。 */
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

  /** 取出尚未通知过的终态作业(每个作业只通知一次)。 */
  drainNotifications(): ShellJobSnapshot[] {
    const notifications: ShellJobSnapshot[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.notified) continue;
      job.notified = true;
      notifications.push(job.snapshot());
    }
    return notifications;
  }

  /** 有作业仍在运行时返回列表(供 /status 之类的展示)。 */
  running(): ShellJobSnapshot[] {
    return this.list().filter((job) => job.status === "running");
  }
}

/** 工具输出里的作业摘要:复用 formatPreservingTail 的头尾保留策略。 */
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
 * 进程级默认作业表。
 * 工具注册表在会话内会被多次重建(cli/agent/session/TUI 命令各建一次),
 * 作业必须跨这些注册表实例存活,所以默认实例挂在进程上而不是注册表上。
 */
export function shellJobs(): ShellJobManager {
  if (!defaultManager) {
    defaultManager = new ShellJobManager();
    process.once("exit", () => defaultManager?.killAll());
  }
  return defaultManager;
}
