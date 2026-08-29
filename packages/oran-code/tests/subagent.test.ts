import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStateStore, type PersistedBackgroundTask } from "../src/subagent/state-store.js";
import {
  BACKGROUND_SUBAGENT_ALLOWED_TOOLS,
  GLOBAL_SUBAGENT_DENIED_TOOLS,
  createSubagentToolFilter,
} from "../src/subagent/filter.js";
import { AgentDefinitionLoader } from "../src/subagent/roles.js";
import { StructuredSubagentScope } from "../src/subagent/scope.js";
import { subagentOriginLabel } from "../src/subagent/types.js";
import type { SubagentRunner } from "../src/subagent/runner.js";
import type { AgentDefinition, SubagentRunOptions, SubagentRunResult } from "../src/subagent/types.js";
import type { ToolDefinition } from "../src/types.js";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oran-subagent-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {},
    permissionLevel: 0,
    maxOutputChars: 1_000,
    invoke: async () => ({ ok: true, output: "" }),
  };
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "reviewer",
    description: "Reviews diffs",
    prompt: "You review diffs.",
    allowedTools: [],
    deniedTools: [],
    scope: "project",
    ...overrides,
  };
}

function backgroundTask(id: string, status: PersistedBackgroundTask["status"] = "running"): PersistedBackgroundTask {
  return {
    id,
    name: `agent-${id}`,
    origin: { kind: "fork", name: `agent-${id}` },
    prompt: "do work",
    startedAt: "2026-08-28T00:00:00.000Z",
    status,
    usage: {},
    notified: false,
  };
}

function runResult(options: SubagentRunOptions, status: SubagentRunResult["status"] = "completed"): SubagentRunResult {
  return {
    taskId: options.taskId ?? "",
    name: options.description,
    origin: options.origin,
    status,
    output: `${options.description} done`,
    usage: { totalTokens: 10 },
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:00:01.000Z",
    conversation: [],
    workspace: "ws",
  };
}

function fakeRunner(handler: (options: SubagentRunOptions) => Promise<SubagentRunResult>): SubagentRunner {
  return { run: handler } as unknown as SubagentRunner;
}

describe("createSubagentToolFilter", () => {
  it("blocks globally denied coordination tools for every subagent", () => {
    const filter = createSubagentToolFilter({
      background: false,
      customAgent: false,
      isMcpTool: () => false,
    });
    for (const name of GLOBAL_SUBAGENT_DENIED_TOOLS) {
      expect(filter(tool(name))).toBe(false);
    }
    expect(filter(tool("read_file"))).toBe(true);
  });

  it("restricts background subagents to the background whitelist", () => {
    const filter = createSubagentToolFilter({
      background: true,
      customAgent: false,
      isMcpTool: () => false,
    });
    for (const name of BACKGROUND_SUBAGENT_ALLOWED_TOOLS) {
      expect(filter(tool(name))).toBe(true);
    }
    expect(filter(tool("update_plan"))).toBe(false);
  });

  it("applies role deny and allow lists, including the wildcard allow", () => {
    const denied = createSubagentToolFilter({
      definition: definition({ deniedTools: ["run_command"] }),
      background: false,
      customAgent: false,
      isMcpTool: () => false,
    });
    expect(denied(tool("run_command"))).toBe(false);
    expect(denied(tool("read_file"))).toBe(true);

    const restricted = createSubagentToolFilter({
      definition: definition({ allowedTools: ["read_file", "glob_files"] }),
      background: false,
      customAgent: false,
      isMcpTool: () => false,
    });
    expect(restricted(tool("read_file"))).toBe(true);
    expect(restricted(tool("write_file"))).toBe(false);

    const wildcard = createSubagentToolFilter({
      definition: definition({ allowedTools: ["*"], deniedTools: ["write_file"] }),
      background: false,
      customAgent: false,
      isMcpTool: () => false,
    });
    expect(wildcard(tool("search_code"))).toBe(true);
    expect(wildcard(tool("write_file"))).toBe(false);
  });

  it("lets MCP tools pass through ahead of the parent filter", () => {
    const filter = createSubagentToolFilter({
      background: false,
      customAgent: false,
      isMcpTool: (name) => name.startsWith("mcp__"),
      parentFilter: () => false,
    });
    expect(filter(tool("mcp__server__query"))).toBe(true);
    expect(filter(tool("read_file"))).toBe(false);
  });

  it("honors custom agent denials", () => {
    const filter = createSubagentToolFilter({
      background: false,
      customAgent: true,
      customDeniedTools: ["search_code"],
      isMcpTool: () => false,
    });
    expect(filter(tool("search_code"))).toBe(false);
    expect(filter(tool("read_file"))).toBe(true);
  });
});

describe("AgentDefinitionLoader", () => {
  const VALID_DEFINITION = `---
name: Reviewer
description: Reviews diffs
allowedTools:
  - read_file
  - glob_files
deniedTools:
  - write_file
permissionMode: plan
maxSteps: 5
isolation: worktree
---
You are a code reviewer subagent.`;

  it("always exposes the builtin definitions sorted by name", async () => {
    const workspace = await makeWorkspace();
    const loader = new AgentDefinitionLoader(workspace, {
      user: join(workspace, "user-agents"),
      project: join(workspace, ".oran", "agents"),
    });
    const scanned = await loader.scan();
    expect(scanned.map((entry) => entry.name)).toEqual(["explore", "general", "plan"]);
    expect(loader.get("PLAN")).toMatchObject({ name: "plan", scope: "builtin", permissionMode: "plan" });
    expect(loader.get("not a name!")).toBeUndefined();
  });

  it("loads valid custom definitions from user and project directories", async () => {
    const workspace = await makeWorkspace();
    const userDir = join(workspace, "user-agents");
    const projectDir = join(workspace, ".oran", "agents");
    await mkdir(userDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(userDir, "reviewer.md"), VALID_DEFINITION, "utf8");
    await writeFile(
      join(projectDir, "auditor.md"),
      VALID_DEFINITION.replace("name: Reviewer", "name: auditor"),
      "utf8",
    );
    // Non-markdown and hidden files are ignored.
    await writeFile(join(userDir, "notes.txt"), "nope", "utf8");

    const loader = new AgentDefinitionLoader(workspace, { user: userDir, project: projectDir });
    const scanned = await loader.scan();
    expect(scanned.map((entry) => entry.name)).toEqual(["auditor", "explore", "general", "plan", "reviewer"]);
    const reviewer = loader.get("reviewer");
    expect(reviewer).toMatchObject({
      name: "reviewer",
      scope: "user",
      permissionMode: "plan",
      workMode: "plan",
      maxSteps: 5,
      isolationMode: "worktree",
      allowedTools: ["read_file", "glob_files"],
      deniedTools: ["write_file"],
    });
    expect(reviewer?.prompt).toBe("You are a code reviewer subagent.");
  });

  it("lets project definitions override user definitions and builtins", async () => {
    const workspace = await makeWorkspace();
    const userDir = join(workspace, "user-agents");
    const projectDir = join(workspace, ".oran", "agents");
    await mkdir(userDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(userDir, "reviewer.md"), VALID_DEFINITION, "utf8");
    await writeFile(
      join(projectDir, "reviewer.md"),
      VALID_DEFINITION.replace("Reviews diffs", "Project-level reviewer"),
      "utf8",
    );
    await writeFile(
      join(projectDir, "explore.md"),
      VALID_DEFINITION.replace("name: Reviewer", "name: explore"),
      "utf8",
    );

    const loader = new AgentDefinitionLoader(workspace, { user: userDir, project: projectDir });
    await loader.scan();
    expect(loader.get("reviewer")).toMatchObject({ description: "Project-level reviewer", scope: "project" });
    expect(loader.get("explore")).toMatchObject({ scope: "project" });
  });

  it.each([
    ["no frontmatter", "just a body, no metadata"],
    ["missing closing fence", "---\nname: reviewer\ndescription: broken\n"],
    ["invalid yaml", "---\nname: reviewer\nname: reviewer\ndescription: dup\n---\nbody"],
    ["invalid agent name", "---\nname: Bad Name!\ndescription: desc\n---\nbody"],
    ["missing description", "---\nname: reviewer\n---\nbody"],
    ["missing prompt body", "---\nname: reviewer\ndescription: desc\n---\n"],
    ["invalid permission mode", "---\nname: reviewer\ndescription: desc\npermissionMode: chaos\n---\nbody"],
    ["invalid maxSteps", "---\nname: reviewer\ndescription: desc\nmaxSteps: 0\n---\nbody"],
    ["invalid isolation", "---\nname: reviewer\ndescription: desc\nisolation: chroot\n---\nbody"],
  ])("skips malformed definitions: %s", async (_label, content) => {
    const workspace = await makeWorkspace();
    const userDir = join(workspace, "user-agents");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "broken.md"), content, "utf8");

    const loader = new AgentDefinitionLoader(workspace, { user: userDir, project: join(workspace, ".oran", "agents") });
    const scanned = await loader.scan();
    expect(scanned.map((entry) => entry.name)).toEqual(["explore", "general", "plan"]);
  });
});

describe("StructuredSubagentScope", () => {
  it("runs a task and reflects the final status", async () => {
    const runner = fakeRunner(async (options) => runResult(options));
    const scope = new StructuredSubagentScope(runner);
    const started = scope.start({
      description: "explore code",
      prompt: "find callers",
      origin: { kind: "fork", name: "explore code" },
    });
    if ("promise" in started) {
      expect(started.status).toBe("running");
      const settled = await started.promise;
      expect(settled.status).toBe("completed");
      expect(scope.list()[0]).toMatchObject({ status: "completed", output: "explore code done" });
    } else {
      throw new Error("expected a structured task, got an unsupported operation");
    }
  });

  it("rejects continue_after_parent_exit without a task host", () => {
    const scope = new StructuredSubagentScope(fakeRunner(async (options) => runResult(options)));
    const unsupported = scope.start({
      description: "orphan",
      prompt: "keep going",
      origin: { kind: "fork", name: "orphan" },
      continueAfterParentExit: true,
    });
    expect(unsupported).toMatchObject({
      code: "unsupported_operation",
      operation: "continue_after_parent_exit",
    });
  });

  it("marks stuck children as timed out and aborts them", async () => {
    const runner = fakeRunner(
      (options) =>
        new Promise<SubagentRunResult>((resolve) => {
          options.abortController?.signal.addEventListener("abort", () => resolve(runResult(options, "cancelled")), {
            once: true,
          });
        }),
    );
    const scope = new StructuredSubagentScope(runner);
    const started = scope.start({ description: "stuck", prompt: "hang", origin: { kind: "fork", name: "stuck" } });
    if (!("promise" in started)) throw new Error("expected a structured task");

    const tasks = await scope.waitForChildren(30);
    expect(tasks[0]).toMatchObject({ status: "timed_out", error: "timed out after 30ms and was cancelled" });
    expect(started.abortController.signal.aborted).toBe(true);
    await started.promise;
    // A late result must not overwrite the timed_out status.
    expect(scope.list()[0]?.status).toBe("timed_out");
    expect(scope.summary()).toContain("stuck: timed out after 30ms and was cancelled");
  });

  it("waits for running children and cancels them on cancelAll", async () => {
    const runner = fakeRunner(async (options) => runResult(options));
    const scope = new StructuredSubagentScope(runner);
    const first = scope.start({ description: "a", prompt: "a", origin: { kind: "fork", name: "a" } });
    if (!("promise" in first)) throw new Error("expected a structured task");
    await scope.waitForChildren(1_000);
    expect(scope.summary()).toContain("a: completed");

    const hanging = fakeRunner(
      (options) =>
        new Promise<SubagentRunResult>((resolve) => {
          options.abortController?.signal.addEventListener("abort", () => resolve(runResult(options, "cancelled")), {
            once: true,
          });
        }),
    );
    const cancelScope = new StructuredSubagentScope(hanging);
    const second = cancelScope.start({ description: "b", prompt: "b", origin: { kind: "fork", name: "b" } });
    if (!("promise" in second)) throw new Error("expected a structured task");
    cancelScope.cancelAll();
    expect(second.abortController.signal.aborted).toBe(true);
  });

  it("rejects invalid fork wait timeouts", () => {
    expect(
      () =>
        new StructuredSubagentScope(
          fakeRunner(async (options) => runResult(options)),
          -1,
        ),
    ).toThrowError(/finite non-negative/);
  });
});

describe("AgentStateStore", () => {
  it("starts from an empty state and round-trips background tasks", async () => {
    const workspace = await makeWorkspace();
    const store = new AgentStateStore(workspace);
    expect(await store.load()).toMatchObject({ version: 1, background: [], teams: [] });

    await store.saveBackground([backgroundTask("t-1", "running")]);
    const loaded = await store.load();
    expect(loaded.background[0]).toMatchObject({ id: "t-1", status: "running" });

    // load() returns clones: mutating the result must not corrupt the store.
    (loaded.background[0] as { status: string }).status = "failed";
    expect((await store.load()).background[0]?.status).toBe("running");

    await store.saveBackground([backgroundTask("t-1", "completed")]);
    const persisted = JSON.parse(await readFile(join(workspace, ".oran", "agents", "state.json"), "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.background[0]).toMatchObject({ id: "t-1", status: "completed" });
  });

  it("debounces scheduled saves until flush", async () => {
    const workspace = await makeWorkspace();
    const store = new AgentStateStore(workspace);
    store.scheduleSaveBackground([backgroundTask("t-1", "running")]);
    await store.flush();
    const persisted = JSON.parse(await readFile(join(workspace, ".oran", "agents", "state.json"), "utf8"));
    expect(persisted.background.map((entry: { id: string }) => entry.id)).toEqual(["t-1"]);
    await store.flush();
  });

  it("ignores state files with an unknown version", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".oran", "agents"), { recursive: true });
    await writeFile(
      join(workspace, ".oran", "agents", "state.json"),
      JSON.stringify({ version: 99, background: [1] }),
      "utf8",
    );
    const store = new AgentStateStore(workspace);
    expect(await store.load()).toMatchObject({ version: 1, background: [], teams: [] });
  });

  it("treats unreadable state files as empty", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".oran", "agents"), { recursive: true });
    await writeFile(join(workspace, ".oran", "agents", "state.json"), "{not json", "utf8");
    const store = new AgentStateStore(workspace);
    expect(await store.load()).toMatchObject({ version: 1, background: [], teams: [] });
  });
});

describe("subagentOriginLabel", () => {
  it("labels every origin kind", () => {
    expect(subagentOriginLabel({ kind: "main" })).toBe("Main Agent");
    expect(subagentOriginLabel({ kind: "definition", name: "plan" })).toBe("Subagent: plan");
    expect(subagentOriginLabel({ kind: "fork", name: "fork-1" })).toBe("Fork: fork-1");
    expect(subagentOriginLabel({ kind: "hook", name: "lint" })).toBe("Hook subagent: lint");
    expect(subagentOriginLabel({ kind: "teammate", name: "dev", teamName: "squad" })).toBe("Teammate: squad/dev");
  });
});
