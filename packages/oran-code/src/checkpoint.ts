import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "./paths.js";
import type { ToolKind } from "./types.js";

/**
 * Task-level checkpoint for crash recovery.
 *
 * The session JSONL already records the conversation, and `rebuildConversation` already drops an
 * incomplete tool batch on restore. What the conversation cannot say on its own is whether the
 * run ended because the process died or because it finished — a killed process writes no
 * terminal record. This file carries that fact, plus the tool calls that were in flight, so the
 * next start can offer to continue from the last completed batch and tell the user which
 * commands may have taken effect without a recorded result.
 *
 * One file per session (`checkpoints/<sessionId>.json`): a session runs one task at a time, and a
 * new task overwrites the previous task's checkpoint.
 */
export const CHECKPOINT_VERSION = 1;

/** A tool call that had started when the checkpoint was written. */
export interface CheckpointToolCall {
  id: string;
  name: string;
  kind?: ToolKind | undefined;
  /** Shell text for `kind: "command"` calls, truncated for the resume notice. */
  command?: string | undefined;
}

export type CheckpointStopReason = "completed" | "cancelled" | "failed" | "paused";

export interface TaskCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  sessionId: string;
  taskId: string;
  /** The user prompt that started this run. */
  prompt: string;
  state: "running" | "finished";
  /** Set only once the run ended normally; an absent reason with state "finished" is repaired on read. */
  stopReason?: CheckpointStopReason | undefined;
  /** Process that owned the run: a live pid means another process is still working on it. */
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** Completed assistant steps in this run. */
  turn: number;
  /** Calls that started and had not reported a result when this file was written. */
  pending: CheckpointToolCall[];
}

const COMMAND_PREVIEW_CHARS = 400;

/** The calls whose effect cannot be known after a crash: shell commands (including background
 * jobs) and calls whose kind could not be resolved when they started. */
export function unknownOutcomeCalls(checkpoint: TaskCheckpoint): CheckpointToolCall[] {
  return checkpoint.pending.filter((call) => call.kind === "command" || call.kind === undefined);
}

/** A pid is treated as alive when signalling reports anything other than "no such process". */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class TaskCheckpointStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: string,
    private readonly persistent = true,
  ) {}

  path(sessionId: string): string {
    return resolve(projectStateRoot(this.workspace), "checkpoints", `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<TaskCheckpoint | undefined> {
    if (!this.persistent) return undefined;
    try {
      return normalizeCheckpoint(JSON.parse(await readFile(this.path(sessionId), "utf8")) as unknown);
    } catch {
      return undefined;
    }
  }

  /** Writes are serialized so a later write never lands before an earlier one. */
  write(checkpoint: TaskCheckpoint): Promise<void> {
    if (!this.persistent) return Promise.resolve();
    const snapshot = structuredClone(checkpoint);
    const job = this.writeTail.then(() => this.writeSnapshot(snapshot));
    this.writeTail = job.catch(() => undefined);
    return job.catch(() => undefined);
  }

  /**
   * Checkpoints that were still running when their owning process died, newest first.
   * A checkpoint whose pid is still alive belongs to another running process and is skipped.
   */
  async interrupted(): Promise<TaskCheckpoint[]> {
    if (!this.persistent) return [];
    const directory = resolve(projectStateRoot(this.workspace), "checkpoints");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }
    const found: TaskCheckpoint[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const sessionId = entry.slice(0, -".json".length);
      const checkpoint = await this.read(sessionId).catch(() => undefined);
      if (!checkpoint || checkpoint.state !== "running") continue;
      if (checkpoint.pid === process.pid || isProcessAlive(checkpoint.pid)) continue;
      found.push(checkpoint);
    }
    return found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async writeSnapshot(checkpoint: TaskCheckpoint): Promise<void> {
    const path = this.path(checkpoint.sessionId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }
}

/** Defensive read: a damaged or older file yields undefined rather than a partial checkpoint. */
function normalizeCheckpoint(value: unknown): TaskCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== CHECKPOINT_VERSION) return undefined;
  if (typeof item.sessionId !== "string" || !item.sessionId) return undefined;
  if (typeof item.taskId !== "string" || !item.taskId) return undefined;
  const state = item.state === "finished" ? "finished" : item.state === "running" ? "running" : undefined;
  if (!state) return undefined;
  const pending = Array.isArray(item.pending)
    ? item.pending
        .filter(
          (call): call is Record<string, unknown> =>
            !!call && typeof call === "object" && typeof (call as Record<string, unknown>).id === "string",
        )
        .map((call) => {
          const kind = call.kind;
          const entry: CheckpointToolCall = {
            id: String(call.id),
            name: typeof call.name === "string" ? call.name : "unknown",
          };
          if (kind === "readonly" || kind === "write" || kind === "command") entry.kind = kind;
          if (typeof call.command === "string") entry.command = call.command;
          return entry;
        })
    : [];
  const stopReason =
    item.stopReason === "completed" ||
    item.stopReason === "cancelled" ||
    item.stopReason === "failed" ||
    item.stopReason === "paused"
      ? item.stopReason
      : undefined;
  return {
    version: CHECKPOINT_VERSION,
    sessionId: item.sessionId,
    taskId: item.taskId,
    prompt: typeof item.prompt === "string" ? item.prompt : "",
    state,
    ...(stopReason ? { stopReason } : {}),
    pid: typeof item.pid === "number" ? item.pid : 0,
    startedAt: typeof item.startedAt === "string" ? item.startedAt : "",
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    turn: typeof item.turn === "number" ? item.turn : 0,
    pending,
  };
}

/** Build the in-flight entry for a tool call about to start. */
export function checkpointToolCall(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  kind: ToolKind | undefined,
): CheckpointToolCall {
  const rawCommand = kind === "command" ? call.arguments.command : undefined;
  return {
    id: call.id,
    name: call.name,
    ...(kind ? { kind } : {}),
    ...(typeof rawCommand === "string"
      ? { command: rawCommand.length > COMMAND_PREVIEW_CHARS ? rawCommand.slice(0, COMMAND_PREVIEW_CHARS) : rawCommand }
      : {}),
  };
}
