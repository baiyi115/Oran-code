import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../src/runtime.js";
import type { AgentDefinition } from "../src/subagent/types.js";
import { SubagentRunner } from "../src/subagent/runner.js";
import { InMemoryTraceStore } from "../src/trace.js";
import { registerBuiltinTools, ToolRegistry } from "../src/tools.js";
import type { Message, ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk, ToolCall } from "../src/types.js";
import { cleanupWorktree } from "../src/worktree/lifecycle.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Subagent worktree lifecycle", () => {
  it("creates and cleans an isolated worktree when the subagent is clean", async () => {
    const root = await createGitFixture("oran-subagent-clean-");
    const provider = new FakeProvider([textResponse("Done")]);
    const runner = createRunner(root, provider);
    const result = await runner.run({
      description: "clean task",
      prompt: "Make no changes.",
      origin: { kind: "definition", name: "clean" },
      definition: worktreeDefinition(),
    });

    expect(result.status).toBe("completed");
    expect(result.worktreeLease).toBeUndefined();
    expect(result.workspace).toContain(join(root, ".oran", "worktrees"));
    await expect(lstat(result.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the worktree lease when the subagent leaves changes", async () => {
    const root = await createGitFixture("oran-subagent-dirty-");
    const provider = new FakeProvider([
      toolResponse({ name: "write_file", arguments: { path: "changed.txt", content: "changed" }, createdAt: new Date().toISOString() }),
      textResponse("Done"),
    ]);
    const runner = createRunner(root, provider);
    const result = await runner.run({
      description: "change files",
      prompt: "Create changed.txt.",
      origin: { kind: "definition", name: "change" },
      definition: worktreeDefinition(),
    });

    expect(result.status).toBe("completed");
    const lease = result.worktreeLease;
    expect(lease).toBeDefined();
    expect(result.workspace).toBe(lease?.path);
    expect(await readFile(join(lease!.path, "changed.txt"), "utf8")).toBe("changed");

    await cleanupWorktree(lease!.repoRoot, lease!.path, lease!.branch);
  });
});

class FakeProvider implements ModelProvider {
  private index = 0;

  constructor(private readonly responses: ModelStreamChunk[][]) {}

  async complete(): Promise<ModelResponse> {
    throw new Error("complete should not be called by TaskController");
  }

  async *streamResponse(_messages: Message[]): AsyncGenerator<ModelStreamChunk> {
    const response = this.responses[this.index++];
    if (!response) throw new Error("fake provider ran out of responses");
    for (const chunk of response) yield chunk;
  }
}

function textResponse(text: string): ModelStreamChunk[] {
  return [
    { type: "text_delta", text: text.slice(0, Math.ceil(text.length / 2)), streamed: true },
    { type: "text_delta", text: text.slice(Math.ceil(text.length / 2)), streamed: true },
    { type: "response_complete", streamed: true, finishReason: "stop" },
  ];
}

function toolResponse(call: ToolCall): ModelStreamChunk[] {
  return [
    {
      type: "tool_call_complete",
      toolCall: {
        index: 0,
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        argumentsJson: JSON.stringify(call.arguments),
      },
      streamed: true,
    },
    { type: "response_complete", streamed: true, finishReason: "tool_calls" },
  ];
}

function worktreeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test",
    description: "",
    prompt: "",
    allowedTools: [],
    deniedTools: [],
    isolationMode: "worktree",
    permissionMode: "bypass",
    scope: "builtin",
    ...overrides,
  };
}

function createRunner(workspace: string, provider: ModelProvider): SubagentRunner {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, workspace);
  registry.activateAll();
  const baseModel: ModelConfig = {
    provider: "test",
    model: "test-model",
    temperature: 0.2,
    maxTokens: 1000,
  };
  return new SubagentRunner({
    workspace,
    registry,
    trace: new InMemoryTraceStore(),
    baseConfig: createRuntimeConfig(workspace, baseModel, { providers: {}, agent: { maxSteps: 5, skipVerify: true } }, false),
    baseModel,
    providerFactory: () => provider,
    resolveModel: () => baseModel,
  });
}

async function createGitFixture(prefix: string): Promise<string> {
  const root = await temporaryDirectory(prefix);
  await runGit(root, ["init"]);
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await commit(root, "initial");
  return root;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function commit(root: string, message: string): Promise<void> {
  await runGit(root, ["-c", "user.name=Oran Test", "-c", "user.email=oran-test@example.invalid", "commit", "-m", message]);
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout;
}
