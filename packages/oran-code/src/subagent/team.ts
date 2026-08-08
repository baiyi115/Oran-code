import type { Message } from "../types.js";
import type { SubagentRunner } from "./runner.js";
import type { AgentDefinition, SubagentRunOptions, TeamSnapshot } from "./types.js";

interface TeamMember {
  readonly name: string;
  status: "idle" | "running" | "stopped" | "failed";
  conversation: readonly Message[];
  readonly mailbox: string[];
  lock: Promise<void>;
  currentAbort?: AbortController;
  toolCount: number;
  lastOutput?: string;
  lastError?: string;
  readonly definition?: AgentDefinition;
  readonly model?: SubagentRunOptions["model"];
  readonly runner: SubagentRunner;
}

interface Team {
  readonly name: string;
  readonly members: Map<string, TeamMember>;
}

export class TeamManager {
  private readonly teams = new Map<string, Team>();
  create(name: string): { ok: boolean; output: string } {
    const normalized = normalizeTeamName(name);
    if (!normalized) return { ok: false, output: "team name must contain letters, digits, or hyphens" };
    if (this.teams.has(normalized)) return { ok: false, output: `team already exists: ${normalized}` };
    this.teams.set(normalized, { name: normalized, members: new Map() });
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
      toolCount: 0,
      runner,
      ...(options.definition ? { definition: options.definition } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    team.members.set(memberName, member);
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
      member.currentAbort?.abort();
    }
    await Promise.allSettled([...team.members.values()].map((member) => member.lock));
    this.teams.delete(team.name);
    return { ok: true, output: `Deleted team ${team.name} and stopped ${team.members.size} teammate(s).` };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.teams.keys()].map((name) => this.delete(name)));
  }

  private enqueue(team: Team, member: TeamMember, prompt: string): void {
    const message = prompt.trim();
    if (!message) return;
    member.mailbox.push(message);
    member.lock = member.lock.then(async () => {
      while (member.mailbox.length && member.status !== "stopped") {
        const next = member.mailbox.shift();
        if (!next) continue;
        member.status = "running";
        const abortController = new AbortController();
        member.currentAbort = abortController;
        const previousToolCount = countToolMessages(member.conversation);
        const result = await member.runner.run({
          description: `${team.name}/${member.name}`,
          prompt: next,
          origin: { kind: "teammate", teamName: team.name, name: member.name },
          conversation: member.conversation,
          abortController,
          ...(member.definition ? { definition: member.definition } : {}),
          ...(member.model ? { model: member.model } : {}),
          customDeniedTools: ["agent"],
        });
        member.conversation = result.conversation;
        member.toolCount += Math.max(0, countToolMessages(result.conversation) - previousToolCount);
        member.lastOutput = result.output;
        if (result.status === "failed") {
          member.status = "failed";
          member.lastError = result.error ?? result.output;
        } else if (result.status === "cancelled" && isMemberStopped(member)) {
          break;
        } else {
          member.status = "idle";
          delete member.lastError;
        }
        delete member.currentAbort;
      }
    }).catch((error) => {
      member.status = "failed";
      member.lastError = error instanceof Error ? error.message : String(error);
      delete member.currentAbort;
    });
  }
}

function isMemberStopped(member: TeamMember): boolean {
  return member.status === "stopped";
}

function countToolMessages(messages: readonly Message[]): number {
  return messages.reduce((count, message) => count + (message.role === "tool" ? 1 : 0), 0);
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
