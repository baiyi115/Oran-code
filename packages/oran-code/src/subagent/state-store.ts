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

export class AgentStateStore {
  private state: PersistedAgentState | undefined;
  private loadPromise: Promise<PersistedAgentState> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: string) {}

  async load(): Promise<PersistedAgentState> {
    if (this.state) return structuredClone(this.state);
    this.loadPromise ??= this.readState();
    this.state = await this.loadPromise;
    return structuredClone(this.state);
  }

  async saveBackground(tasks: readonly PersistedBackgroundTask[]): Promise<void> {
    await this.mutate((state) => ({
      ...state,
      updatedAt: new Date().toISOString(),
      background: structuredClone(tasks),
    }));
  }

  async saveTeams(teams: readonly PersistedTeam[]): Promise<void> {
    await this.mutate((state) => ({
      ...state,
      updatedAt: new Date().toISOString(),
      teams: structuredClone(teams),
    }));
  }

  async flush(): Promise<void> {
    await this.mutationTail;
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

  private async mutate(mutator: (state: PersistedAgentState) => PersistedAgentState): Promise<void> {
    const mutation = this.mutationTail.then(async () => {
      const state = await this.load();
      this.state = mutator(state);
      const snapshot = structuredClone(this.state);
      const path = this.path();
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    });
    this.mutationTail = mutation.catch(() => undefined);
    await mutation;
  }

  private path(): string {
    return resolve(projectStateRoot(this.workspace), "agents", "state.json");
  }
}
