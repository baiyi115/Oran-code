import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "../paths.js";
import type { Message } from "../types.js";
import type { PersistedSubagentStatus, SubagentOrigin, SubagentWorktreeLease } from "./types.js";

export interface PersistedBackgroundTask {
  readonly id: string;
  readonly name: string;
  readonly origin: SubagentOrigin;
  readonly prompt: string;
  readonly definitionName?: string;
  readonly modelReference?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: PersistedSubagentStatus;
  readonly output?: string;
  readonly error?: string;
  readonly usage: Readonly<Record<string, number>>;
  readonly notified: boolean;
  readonly worktreeLease?: SubagentWorktreeLease;
  readonly retryOf?: string;
}

export interface PersistedTeamMember {
  readonly name: string;
  readonly status: "idle" | "running" | "stopped" | "failed" | "interrupted";
  readonly conversation: readonly Message[];
  readonly mailbox: readonly string[];
  readonly currentPrompt?: string;
  readonly toolCount: number;
  readonly lastOutput?: string;
  readonly lastError?: string;
  readonly definitionName?: string;
  readonly modelReference?: string;
  readonly worktreeLease?: SubagentWorktreeLease;
}

export interface PersistedTeam {
  readonly name: string;
  readonly members: readonly PersistedTeamMember[];
}

interface PersistedAgentState {
  readonly version: 1;
  readonly updatedAt: string;
  readonly background: readonly PersistedBackgroundTask[];
  readonly teams: readonly PersistedTeam[];
}

const EMPTY_STATE: PersistedAgentState = {
  version: 1,
  updatedAt: "",
  background: [],
  teams: [],
};

const PERSIST_DEBOUNCE_MS = 500;

export class AgentStateStore {
  private state: PersistedAgentState | undefined;
  private loadPromise: Promise<PersistedAgentState> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private dirty = false;
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(private readonly workspace: string) {}

  async load(): Promise<PersistedAgentState> {
    if (this.state) return structuredClone(this.state);
    this.loadPromise ??= this.readState();
    this.state = await this.loadPromise;
    return structuredClone(this.state);
  }

  async saveBackground(tasks: readonly PersistedBackgroundTask[]): Promise<void> {
    await this.mutate(
      (state) => ({
        ...state,
        updatedAt: new Date().toISOString(),
        background: structuredClone(tasks),
      }),
      { persistNow: true },
    );
  }

  async saveTeams(teams: readonly PersistedTeam[]): Promise<void> {
    await this.mutate(
      (state) => ({
        ...state,
        updatedAt: new Date().toISOString(),
        teams: structuredClone(teams),
      }),
      { persistNow: true },
    );
  }

  /**
   * 中间态写入:内存立即更新,磁盘写入防抖 500ms 合并。
   * 崩溃最多丢失窗口内的中间状态,restore 会将其标记为 interrupted。
   */
  scheduleSaveBackground(tasks: readonly PersistedBackgroundTask[]): void {
    void this.mutate(
      (state) => ({
        ...state,
        updatedAt: new Date().toISOString(),
        background: structuredClone(tasks),
      }),
      { persistNow: false },
    );
  }

  scheduleSaveTeams(teams: readonly PersistedTeam[]): void {
    void this.mutate(
      (state) => ({
        ...state,
        updatedAt: new Date().toISOString(),
        teams: structuredClone(teams),
      }),
      { persistNow: false },
    );
  }

  async flush(): Promise<void> {
    await this.mutationTail;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.dirty) {
      const job = this.mutationTail.then(() => this.writeSnapshot()).catch(() => undefined);
      this.mutationTail = job;
      await job;
    }
  }

  private async readState(): Promise<PersistedAgentState> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as Partial<PersistedAgentState>;
      if (parsed.version !== 1) return { ...EMPTY_STATE };
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        background: Array.isArray(parsed.background) ? parsed.background : [],
        teams: Array.isArray(parsed.teams) ? parsed.teams : [],
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  private async mutate(
    mutator: (state: PersistedAgentState) => PersistedAgentState,
    options: { persistNow: boolean },
  ): Promise<void> {
    const mutation = this.mutationTail.then(async () => {
      const state = await this.load();
      this.state = mutator(state);
      this.dirty = true;
      if (options.persistNow) {
        await this.writeSnapshot();
      } else {
        this.scheduleWrite();
      }
    });
    this.mutationTail = mutation.catch(() => undefined);
    await mutation;
  }

  /** 定时器到点后经串行链写入当前内存快照,避免旧快照覆盖新快照。 */
  private scheduleWrite(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const job = this.mutationTail.then(() => this.writeSnapshot()).catch(() => undefined);
      this.mutationTail = job;
    }, PERSIST_DEBOUNCE_MS);
    // 保持进程可退出;flush/shutdown 负责最后的落盘。
    this.persistTimer.unref?.();
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
    return resolve(projectStateRoot(this.workspace), "agents", "state.json");
  }
}
