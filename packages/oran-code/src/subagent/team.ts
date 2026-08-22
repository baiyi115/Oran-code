import type { Message, ModelConfig } from "../types.js";
import type { SubagentRunner } from "./runner.js";
import type { AgentStateStore, PersistedTeam, PersistedTeamMember } from "./state-store.js";
import type { AgentDefinition, SubagentRunOptions, SubagentWorktreeLease, TeamSnapshot } from "./types.js";

type TeamMemberStatus = "idle" | "running" | "stopped" | "failed" | "interrupted";

interface TeamMember {
  readonly name: string;
  status: TeamMemberStatus;
  conversation: readonly Message[];
  readonly mailbox: string[];
  currentPrompt?: string;
  lock: Promise<void>;
  processing: boolean;
  currentAbort?: AbortController;
  toolCount: number;
  lastOutput?: string;
  lastError?: string;
  readonly definitionName?: string;
  readonly modelReference?: string;
  worktreeLease?: SubagentWorktreeLease;
}

interface Team {
  readonly name: string;
  readonly members: Map<string, TeamMember>;
}

interface TeamRuntime {
  readonly runner: SubagentRunner;
  readonly resolveDefinition: (name: string) => AgentDefinition | undefined;
  readonly resolveModel: (reference: string) => ModelConfig;
}

export class TeamManager {
  private readonly teams = new Map<string, Team>();
  private runtime: TeamRuntime | undefined;

  constructor(private readonly stateStore?: AgentStateStore) {}

  async restore(): Promise<void> {
    if (!this.stateStore) return;
    const state = await this.stateStore.load();
    for (const persisted of state.teams) {
      const team: Team = { name: persisted.name, members: new Map() };
      for (const item of persisted.members) {
        team.members.set(item.name, {
          ...structuredClone(item),
          status: item.status === "running" ? "interrupted" : item.status,
          mailbox: [...item.mailbox],
          lock: Promise.resolve(),
          processing: false,
        });
      }
      this.teams.set(team.name, team);
    }
    await this.persist();
  }

  attachRuntime(runtime: TeamRuntime): void {
    this.runtime = runtime;
    for (const team of this.teams.values()) {
      for (const member of team.members.values()) {
        if (member.status === "idle" && member.mailbox.length) this.schedule(team, member);
      }
    }
  }

  create(name: string): { ok: boolean; output: string } {
    const normalized = normalizeTeamName(name);
    if (!normalized) return { ok: false, output: "team name must contain letters, digits, or hyphens" };
    if (this.teams.has(normalized)) return { ok: false, output: `team already exists: ${normalized}` };
    this.teams.set(normalized, { name: normalized, members: new Map() });
    this.schedulePersist();
    return { ok: true, output: `Created team ${normalized}.` };
  }

  spawn(
    runner: SubagentRunner,
    teamName: string,
    description: string,
    prompt: string,
    options: { readonly definition?: AgentDefinition; readonly model?: SubagentRunOptions["model"] } = {},
  ): { ok: boolean; output: string; memberName?: string } {
    const team = this.teams.get(normalizeTeamName(teamName) ?? "");
    if (!team) return { ok: false, output: `Unknown team ${teamName}. Create it with team_create first.` };
    const memberName = uniqueMemberName(team, deriveMemberName(description));
    const member: TeamMember = {
      name: memberName,
      status: "idle",
      conversation: [],
      mailbox: [],
      lock: Promise.resolve(),
      processing: false,
      toolCount: 0,
      ...(options.definition ? { definitionName: options.definition.name } : {}),
      ...(options.model ? { modelReference: modelReference(options.model) } : {}),
    };
    team.members.set(memberName, member);
    this.runtime = this.runtime ?? {
      runner,
      resolveDefinition: (name) => options.definition?.name === name ? options.definition : undefined,
      resolveModel: (reference) => {
        if (options.model && modelReference(options.model) === reference) return options.model;
        throw new Error(`model is not available: ${reference}`);
      },
    };
    this.enqueue(team, member, prompt);
    return { ok: true, output: `Spawned teammate ${team.name}/${memberName}; work has started.`, memberName };
  }

  send(teamName: string, memberName: string, prompt: string): { ok: boolean; output: string } {
    const team = this.teams.get(normalizeTeamName(teamName) ?? "");
    const member = team?.members.get(normalizeMemberName(memberName));
    if (!team || !member) return { ok: false, output: `Unknown teammate ${teamName}/${memberName}.` };
    if (member.status === "stopped") return { ok: false, output: `Teammate ${team.name}/${member.name} is stopped.` };
    this.enqueue(team, member, prompt);
    return { ok: true, output: `Message queued for ${team.name}/${member.name}.` };
  }

  resume(teamName: string, memberName: string): { ok: boolean; output: string } {
    const team = this.teams.get(normalizeTeamName(teamName) ?? "");
    const member = team?.members.get(normalizeMemberName(memberName));
    if (!team || !member) return { ok: false, output: `Unknown teammate ${teamName}/${memberName}.` };
    if (member.status !== "interrupted") return { ok: false, output: `Teammate ${team.name}/${member.name} is not interrupted.` };
    if (member.currentPrompt) member.mailbox.unshift(member.currentPrompt);
    delete member.currentPrompt;
    member.status = "idle";
    delete member.lastError;
    this.schedulePersist();
    this.schedule(team, member);
    return { ok: true, output: `Resumed teammate ${team.name}/${member.name}.` };
  }

  list(): readonly TeamSnapshot[] {
    return [...this.teams.values()].map((team) => ({
      name: team.name,
      members: [...team.members.values()].map((member) => ({
        name: member.name,
        status: member.status,
        queuedMessages: member.mailbox.length,
        toolCount: member.toolCount,
        ...(member.lastOutput ? { lastOutput: member.lastOutput } : {}),
        ...(member.lastError ? { lastError: member.lastError } : {}),
      })),
    }));
  }

  async delete(name: string): Promise<{ ok: boolean; output: string }> {
    const normalized = normalizeTeamName(name);
    const team = normalized ? this.teams.get(normalized) : undefined;
    if (!team) return { ok: false, output: `Unknown team ${name}.` };
    for (const member of team.members.values()) {
      member.status = "stopped";
      member.mailbox.splice(0);
      delete member.currentPrompt;
      member.currentAbort?.abort();
    }
    await Promise.allSettled([...team.members.values()].map((member) => member.lock));
    this.teams.delete(team.name);
    await this.persist();
    return { ok: true, output: `Deleted team ${team.name} and stopped ${team.members.size} teammate(s).` };
  }

  async shutdown(): Promise<void> {
    for (const team of this.teams.values()) {
      for (const member of team.members.values()) {
        if (member.status !== "running") continue;
        member.status = "interrupted";
        member.currentAbort?.abort();
      }
    }
    await this.persist();
    await Promise.allSettled([...this.teams.values()].flatMap((team) => [...team.members.values()].map((member) => member.lock)));
  }

  async flush(): Promise<void> {
    await this.persist();
  }

  private enqueue(team: Team, member: TeamMember, prompt: string): void {
    const message = prompt.trim();
    if (!message) return;
    member.mailbox.push(message);
    this.schedulePersist();
    if (member.status === "idle") this.schedule(team, member);
  }

  private schedule(team: Team, member: TeamMember): void {
    if (member.processing || !this.runtime || member.status !== "idle") return;
    member.processing = true;
    member.lock = member.lock.then(async () => {
      while (member.mailbox.length && member.status === "idle") {
        const next = member.mailbox.shift();
        if (!next) continue;
        member.currentPrompt = next;
        member.status = "running";
        const abortController = new AbortController();
        member.currentAbort = abortController;
        await this.persist();
        const previousToolCount = countToolMessages(member.conversation);
        try {
          const definition = member.definitionName ? this.runtime?.resolveDefinition(member.definitionName) : undefined;
          if (member.definitionName && !definition) throw new Error(`agent definition is not available: ${member.definitionName}`);
          const model = member.modelReference ? this.runtime?.resolveModel(member.modelReference) : undefined;
          const result = await this.runtime!.runner.run({
            description: `${team.name}/${member.name}`,
            prompt: next,
            origin: { kind: "teammate", teamName: team.name, name: member.name },
            conversation: member.conversation,
            abortController,
            ...(definition ? { definition } : {}),
            ...(model ? { model } : {}),
            ...(member.worktreeLease ? { worktreeLease: member.worktreeLease } : {}),
            worktreeLeaseCallback: async (lease) => {
              if (lease) member.worktreeLease = lease;
              else delete member.worktreeLease;
              await this.persist();
            },
            customDeniedTools: ["agent"],
          });
          if (isInterrupted(member)) {
            if (result.worktreeLease) member.worktreeLease = result.worktreeLease;
            else delete member.worktreeLease;
            break;
          }
          member.conversation = result.conversation;
          member.toolCount += Math.max(0, countToolMessages(result.conversation) - previousToolCount);
          member.lastOutput = result.output;
          if (result.worktreeLease) member.worktreeLease = result.worktreeLease;
          else delete member.worktreeLease;
          delete member.currentPrompt;
          if (result.status === "failed") {
            member.status = "failed";
            member.lastError = result.error ?? result.output;
          } else {
            member.status = "idle";
            delete member.lastError;
          }
        } catch (error) {
          if (!isInterrupted(member)) {
            member.status = "failed";
            member.lastError = error instanceof Error ? error.message : String(error);
          }
        } finally {
          delete member.currentAbort;
          await this.persist();
        }
      }
    }).finally(() => {
      member.processing = false;
      if (member.status === "idle" && member.mailbox.length) this.schedule(team, member);
    });
  }

  private async persist(): Promise<void> {
    await this.stateStore?.saveTeams([...this.teams.values()].map(serializeTeam));
  }

  /** 中间态(创建团队、入队、投递)落盘走防抖,完成/中断边界仍立即持久化。 */
  private schedulePersist(): void {
    this.stateStore?.scheduleSaveTeams([...this.teams.values()].map(serializeTeam));
  }
}

function isInterrupted(member: TeamMember): boolean {
  return (member.status as TeamMemberStatus) === "interrupted";
}

function serializeTeam(team: Team): PersistedTeam {
  return { name: team.name, members: [...team.members.values()].map(serializeMember) };
}

function serializeMember(member: TeamMember): PersistedTeamMember {
  const { lock: _lock, processing: _processing, currentAbort: _currentAbort, ...persisted } = member;
  return { ...persisted, mailbox: [...persisted.mailbox], conversation: structuredClone([...persisted.conversation]) };
}

function countToolMessages(messages: readonly Message[]): number {
  return messages.reduce((count, message) => count + (message.role === "tool" ? 1 : 0), 0);
}

function modelReference(model: ModelConfig): string {
  return `${model.provider}/${model.model}`;
}

function normalizeTeamName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || undefined;
}

function normalizeMemberName(value: string): string {
  return deriveMemberName(value);
}

function deriveMemberName(description: string): string {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (normalized || "teammate").slice(0, 32).replace(/-$/g, "") || "teammate";
}

function uniqueMemberName(team: Team, requested: string): string {
  if (!team.members.has(requested)) return requested;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${requested.slice(0, Math.max(1, 31 - String(suffix).length))}-${suffix}`;
    if (!team.members.has(candidate)) return candidate;
  }
}
