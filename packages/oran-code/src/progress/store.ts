import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "../paths.js";
import type { TurnSnapshot } from "./capture.js";
import type { NoveltyState } from "./novelty.js";
import type { RehearsalData } from "./rehearsal.js";

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
  /** Symbol-novelty tracker (mechanism B1). */
  novelty?: NoveltyState | undefined;
  /** Pending structured rehearsal (mechanism B2). */
  rehearsal?: { phase: "requested" | "reflected"; requestedTurn: number; last?: RehearsalData | undefined } | undefined;
  /** How the previous run of this task ended; absent while still running. */
  stop?: ProgressStop | undefined;
  /**
   * "off" while the user has explicitly resumed a paused task: the gate still
   * records signals but no longer pauses on them, which is the escape hatch the
   * pause message promises.
   */
  enforcement?: "off" | undefined;
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

/**
 * A run that starts from scratch: the configured budgets survive, the previous
 * run's window does not. Used for a new task and for re-running a goal whose
 * previous run already ended — replaying a finished run's warnings into a fresh
 * task was pure noise, and its phase counters described work that is over.
 */
export function freshRunState(previous: PersistedProgressState, goalFingerprint: string): PersistedProgressState {
  return {
    ...EMPTY_PROGRESS_STATE,
    goalFingerprint,
    exploreBudget: previous.exploreBudget,
    implementBudget: previous.implementBudget,
  };
}

export type RunStateOrigin = "new-goal" | "resumed" | "previous-run-ended" | "interrupted";

/**
 * Which persisted state a run starts from, and why.
 *
 * `resumed` is set when /resume handed this run the paused attempt's identity.
 * The interrupted case replays the previous window, but it must not inherit
 * `enforcement: "off"`: that disarm belongs to the resumed attempt, which is
 * over. A cancelled or failed run writes no stop, so the next run of the same
 * prompt took this branch and stayed disarmed, silently.
 */
export function selectRunState(
  persisted: PersistedProgressState,
  goalFingerprint: string,
  options: { resumed: boolean },
): { state: PersistedProgressState; origin: RunStateOrigin } {
  if (persisted.goalFingerprint !== goalFingerprint) {
    return { state: freshRunState(persisted, goalFingerprint), origin: "new-goal" };
  }
  if (options.resumed) {
    return { state: resumedRunState(persisted, goalFingerprint), origin: "resumed" };
  }
  if (persisted.stop !== undefined) {
    return { state: freshRunState(persisted, goalFingerprint), origin: "previous-run-ended" };
  }
  const { enforcement: _disarmOfTheAttemptThatEnded, ...interrupted } = persisted;
  return { state: interrupted, origin: "interrupted" };
}

/**
 * Adopt a paused run (/resume): keep what the task already learned about the
 * repository, restart the counters that tripped the gate, and leave the gate
 * disarmed so the user's decision to continue is not immediately overruled.
 */
export function resumedRunState(previous: PersistedProgressState, goalFingerprint: string): PersistedProgressState {
  return {
    ...freshRunState(previous, goalFingerprint),
    allowedPaths: previous.allowedPaths,
    novelty: previous.novelty,
    phase: previous.phase
      ? { ...previous.phase, readonlyFilesRead: 0, implementTurns: 0, consecutiveReadTurns: 0, egressCount: 0 }
      : previous.phase,
    enforcement: "off",
  };
}

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
    // Clearing the timer only cancels the pending write; the state still has to
    // reach disk, so this queues a real snapshot (awaiting writeTail alone would
    // await an already-settled promise and write nothing).
    if (this.dirty) {
      const job = this.writeTail.then(() => this.writeSnapshot()).catch(() => undefined);
      this.writeTail = job;
      await job;
    }
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
        novelty: parsed.novelty && typeof parsed.novelty === "object" ? (parsed.novelty as NoveltyState) : undefined,
        rehearsal:
          parsed.rehearsal && typeof parsed.rehearsal === "object"
            ? (parsed.rehearsal as PersistedProgressState["rehearsal"])
            : undefined,
        stop: parsed.stop && typeof parsed.stop === "object" ? (parsed.stop as ProgressStop) : undefined,
        enforcement: parsed.enforcement === "off" ? "off" : undefined,
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
