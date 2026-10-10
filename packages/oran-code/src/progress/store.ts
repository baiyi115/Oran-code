import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "../paths.js";
import type { TurnSnapshot } from "./capture.js";

/**
 * Out-of-band progress state: task-level fixed fields plus a window of the
 * most recent snapshots. Lives outside the conversation so compaction or a
 * restart cannot drop it. Persistence mirrors subagent/state-store.ts:
 * terminal writes are immediate, intermediate writes debounce 500ms, snapshots
 * are written atomically (tmp + rename), and a missing or corrupt file heals
 * to the empty state without erroring.
 */

export const PROGRESS_STATE_VERSION = 1;
/** Snapshot window size; recovery only replays warn-and-above signals. */
export const MAX_SNAPSHOTS = 20;
const PERSIST_DEBOUNCE_MS = 500;

/** How the task last ended, as seen by the progress layer. */
export type ProgressStopKind = "verified" | "review_required" | "blocked" | "stopped_by_budget";

export interface ProgressStop {
  kind: ProgressStopKind;
  turn: number;
  ts: string;
}

export interface PersistedProgressState {
  version: typeof PROGRESS_STATE_VERSION;
  updatedAt: string;
  /** Hash of the initial task prompt; stable within a task. */
  goalFingerprint: string;
  /** Target file set; empty until the first real mutation establishes it. */
  allowedPaths: string[];
  /** Per-task budgets; 0 means "unset, use module defaults". */
  exploreBudget: number;
  implementBudget: number;
  /** Phase machine state; absent in states written before phasing existed. */
  phase?: PhasePersistedState | undefined;
  /** How the previous run of this task ended; absent while still running. */
  stop?: ProgressStop | undefined;
  snapshots: TurnSnapshot[];
}

export interface PhasePersistedState {
  phase: "explore" | "implement";
  readonlyFilesRead: number;
  implementTurns: number;
  consecutiveReadTurns: number;
  egressCount: number;
}

export const EMPTY_PROGRESS_STATE: PersistedProgressState = {
  version: PROGRESS_STATE_VERSION,
  updatedAt: "",
  goalFingerprint: "",
  allowedPaths: [],
  exploreBudget: 0,
  implementBudget: 0,
  phase: undefined,
  snapshots: [],
};

export class ProgressStateStore {
  private state: PersistedProgressState | undefined;
  private loadPromise: Promise<PersistedProgressState> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private dirty = false;
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(private readonly workspace: string) {}

  async load(): Promise<PersistedProgressState> {
    if (this.state) return structuredClone(this.state);
    this.loadPromise ??= this.readState();
    this.state = await this.loadPromise;
    return structuredClone(this.state);
  }

  async save(state: PersistedProgressState): Promise<void> {
    await this.write(state, /* now */ true);
  }

  /** Intermediate write: memory updates immediately, disk write debounces 500ms. */
  scheduleSave(state: PersistedProgressState): void {
    void this.write(state, false);
  }

  async flush(): Promise<void> {
    await this.writeTail;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.dirty) await this.writeTail;
  }

  private async write(state: PersistedProgressState, now: boolean): Promise<void> {
    const job = this.writeTail.then(async () => {
      this.state = structuredClone(state);
      this.dirty = true;
      if (now) {
        if (this.persistTimer) {
          clearTimeout(this.persistTimer);
          this.persistTimer = undefined;
        }
        await this.writeSnapshot();
      } else {
        this.scheduleWrite();
      }
    });
    this.writeTail = job.catch(() => undefined);
    await job;
  }

  private scheduleWrite(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const job = this.writeTail.then(() => this.writeSnapshot()).catch(() => undefined);
      this.writeTail = job;
    }, PERSIST_DEBOUNCE_MS);
    // Keep the process free to exit; flush() owns the final write.
    this.persistTimer.unref?.();
  }

  private async readState(): Promise<PersistedProgressState> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as Partial<PersistedProgressState>;
      if (parsed.version !== PROGRESS_STATE_VERSION) return { ...EMPTY_PROGRESS_STATE };
      return {
        version: PROGRESS_STATE_VERSION,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        goalFingerprint: typeof parsed.goalFingerprint === "string" ? parsed.goalFingerprint : "",
        allowedPaths: Array.isArray(parsed.allowedPaths)
          ? parsed.allowedPaths.filter((p): p is string => typeof p === "string")
          : [],
        exploreBudget: typeof parsed.exploreBudget === "number" ? parsed.exploreBudget : 0,
        implementBudget: typeof parsed.implementBudget === "number" ? parsed.implementBudget : 0,
        phase: parsed.phase && typeof parsed.phase === "object" ? (parsed.phase as PhasePersistedState) : undefined,
        stop: parsed.stop && typeof parsed.stop === "object" ? (parsed.stop as ProgressStop) : undefined,
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      };
    } catch {
      return { ...EMPTY_PROGRESS_STATE };
    }
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.state) return;
    this.dirty = false;
    const snapshot = structuredClone(this.state);
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private path(): string {
    return resolve(projectStateRoot(this.workspace), "progress", "state.json");
  }
}
