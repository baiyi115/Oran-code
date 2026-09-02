import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolBatchExecutor, type ToolExecutorPorts } from "../src/controller/tool-executor.js";
import type { ContextManager } from "../src/context-manager.js";
import type { AgentLoop } from "../src/loop.js";
import type { SnapshotStorePort } from "../src/snapshot.js";
import type { PermissionPolicy } from "../src/security.js";
import type { TraceStore } from "../src/trace.js";
import { ToolRegistry } from "../src/tools.js";
import { BATCH_TOOL_NAME } from "../src/tools/batch-tools.js";
import type {
  HookEventPortContext,
  RuntimeConfig,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolKind,
  ToolResult,
} from "../src/types.js";
import { createTask } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oran-executor-"));
  roots.push(root);
  return root;
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, arguments: args, createdAt: "2026-08-28T00:00:00.000Z" };
}

interface InvokeRecord {
  name: string;
  event: "start" | "end";
  at: number;
}

function makeTool(
  name: string,
  kind: ToolKind,
  handler?: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: {},
    permissionLevel: kind === "readonly" ? 0 : 2,
    kind,
    maxOutputChars: 20_000,
    invoke: handler ?? (async () => ({ ok: true, output: `${name} ok` })),
    ...overrides,
  };
}

function makeHarness(
  workspace: string,
  options: {
    tools?: ToolDefinition[];
    workMode?: RuntimeConfig["workMode"];
    checkBeforeToolHook?: (
      task: Parameters<ToolExecutorPorts["checkBeforeToolHook"]>[0],
      call: ToolCall,
    ) => Promise<ToolResult | undefined>;
    snapshotStore?: SnapshotStorePort;
    getAbortSignal?: () => AbortSignal | undefined;
    offload?: (candidates: readonly { id: string; content: string }[]) => Promise<{
      replacements: Map<string, string>;
      offloadedCount: number;
      failedCount: number;
    }>;
    shouldStopForUnknownTools?: boolean;
  } = {},
) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const hookCalls: HookEventPortContext[] = [];

  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);

  let callIdCounter = 0;
  const contextManager = {
    claimToolCallId: () => `call_${++callIdCounter}`,
    offloadToolResults:
      options.offload ?? (async () => ({ replacements: new Map(), offloadedCount: 0, failedCount: 0 })),
  } as unknown as ContextManager;

  const trace = { appendToolCall: vi.fn(), appendFileChange: vi.fn() } as unknown as TraceStore;
  const permission = {
    decide: vi.fn(async () => ({ verdict: "allow", source: "user-rule", reason: "allowed", level: 0 })),
    allowForTask: vi.fn(),
    allowPermanently: vi.fn(async () => {}),
  } as unknown as PermissionPolicy;
  const loopStub = {
    record: vi.fn(),
    recordUnknownTool: vi.fn(),
    shouldStopForUnknownTools: vi.fn(() => options.shouldStopForUnknownTools ?? false),
    recordResult: vi.fn(),
    canRecordToolCall: vi.fn(() => true),
  } as unknown as AgentLoop;

  const config: RuntimeConfig = {
    workspace,
    model: { provider: "test", model: "test-model", temperature: 0, maxTokens: 1024 },
    workMode: options.workMode ?? "auto",
    permissionMode: "default",
    loop: {
      maxSteps: 20,
      maxRetries: 2,
      commandTimeout: 5_000,
      noProgressLimit: 0,
      tokenBudget: 0,
      unknownToolLimit: 0,
      readonlyConcurrency: 4,
    },
    permissions: { workspace } as RuntimeConfig["permissions"],
    subagent: { forkWaitTimeoutMs: 600_000 },
    skipVerify: true,
    approveAll: false,
  };

  const snapshotStore = options.snapshotStore;
  const ports: ToolExecutorPorts = {
    config,
    registry,
    contextManager,
    trace,
    permission,
    logger: vi.fn(),
    debugLogger: vi.fn(),
    readonlyCache: new Map(),
    snapshotStore,
    snapshotSessionId: snapshotStore ? "session-1" : undefined,
    emit: async (type, payload) => {
      events.push({ type, payload });
    },
    persist: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => true),
    fireHook: async (ctx) => {
      hookCalls.push(ctx);
    },
    checkBeforeToolHook: options.checkBeforeToolHook ?? (async () => undefined),
    isToolVisible: () => true,
    syncConversation: vi.fn(),
    appendDiagnosticStep: vi.fn(() => 1),
    trackSuccessfulFileRead: vi.fn(async () => {}),
    throwIfCancelled: () => {},
    getLoop: () => loopStub,
    getAbortSignal: () => options.getAbortSignal?.(),
    getTurnSequence: () => 1,
    getModelResponseStepId: () => undefined,
  };

  return { executor: new ToolBatchExecutor(ports), ports, registry, events, hookCalls, permission, loopStub };
}

function timedTool(name: string, kind: ToolKind, delayMs: number, log: InvokeRecord[]): ToolDefinition {
  return makeTool(name, kind, async (callArg, context) => {
    log.push({ name, event: "start", at: Date.now() });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    log.push({ name, event: "end", at: Date.now() });
    return { ok: true, output: `${name}:${callArg.id}:${context?.workspace ?? ""}` };
  });
}

function runMessages(): Parameters<ToolBatchExecutor["runTools"]>[1] {
  return [];
}

describe("ToolBatchExecutor batching", () => {
  it("runs consecutive readonly calls concurrently and records results in model order", async () => {
    const workspace = await makeWorkspace();
    const { executor, registry, events, loopStub } = makeHarness(workspace);
    const execLog: InvokeRecord[] = [];
    registry.register(timedTool("slow_a", "readonly", 80, execLog));
    registry.register(timedTool("fast_b", "readonly", 5, execLog));
    const task = createTask(workspace, "run tools");
    const messages = runMessages();

    const summary = await executor.runTools(task, messages, [call("slow_a"), call("fast_b")], loopStub);

    expect(summary).toEqual({ workspaceMutated: false, readonlyOnly: true });
    const endA = execLog.find((entry) => entry.name === "slow_a" && entry.event === "end")!;
    const startB = execLog.find((entry) => entry.name === "fast_b" && entry.event === "start")!;
    expect(startB.at).toBeLessThan(endA.at);

    expect(messages.map((message) => message.name)).toEqual(["slow_a", "fast_b"]);
    const resultEvents = events.filter((event) => event.type === "tool_result");
    expect(resultEvents.map((event) => (event.payload as { call: ToolCall }).call.name)).toEqual(["slow_a", "fast_b"]);
    expect(resultEvents.map((event) => (event.payload as { index: number }).index)).toEqual([0, 1]);
  });

  it("serializes mutating tools between readonly batches", async () => {
    const workspace = await makeWorkspace();
    const { executor, registry, loopStub } = makeHarness(workspace);
    const execLog: InvokeRecord[] = [];
    registry.register(timedTool("read_a", "readonly", 20, execLog));
    registry.register(timedTool("run_command", "command", 10, execLog));
    registry.register(timedTool("read_b", "readonly", 20, execLog));
    const task = createTask(workspace, "interleaved");
    const messages = runMessages();

    const summary = await executor.runTools(
      task,
      messages,
      [call("read_a"), call("run_command"), call("read_b")],
      loopStub,
    );

    expect(summary.readonlyOnly).toBe(false);
    const sequence = execLog.map((entry) => `${entry.name}:${entry.event}`);
    expect(sequence).toEqual([
      "read_a:start",
      "read_a:end",
      "run_command:start",
      "run_command:end",
      "read_b:start",
      "read_b:end",
    ]);
  });

  it("reports unknown tools, records the failure and honours the loop stop signal", async () => {
    const workspace = await makeWorkspace();
    const { executor, registry, loopStub } = makeHarness(workspace, { shouldStopForUnknownTools: true });
    registry.register(timedTool("read_a", "readonly", 0, []));
    const task = createTask(workspace, "unknown tool");
    const messages = runMessages();

    const summary = await executor.runTools(task, messages, [call("nope"), call("read_a")], loopStub);

    expect(summary.readonlyOnly).toBe(false);
    expect(loopStub.recordUnknownTool).toHaveBeenCalledWith(expect.objectContaining({ name: "nope" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ name: "nope" });
    expect(messages[0]?.content).toContain("unknown tool: nope");
  });

  it("denies non-plan tools in plan mode while readonly tools keep running", async () => {
    const workspace = await makeWorkspace();
    const { executor, events, loopStub } = makeHarness(workspace, {
      tools: [makeTool("write_file", "write"), makeTool("read_file", "readonly")],
      workMode: "plan",
    });
    const task = createTask(workspace, "plan mode");
    const messages = runMessages();

    await executor.runTools(
      task,
      messages,
      [call("write_file", { path: "a.ts" }), call("read_file", { path: "a.ts" })],
      loopStub,
    );

    const writeEvent = events.find(
      (event) => event.type === "tool_result" && (event.payload as { call: ToolCall }).call.name === "write_file",
    );
    const writeResult = (writeEvent?.payload as { result: ToolResult }).result;
    expect(writeResult.ok).toBe(false);
    expect(writeResult.metadata?.permissionDenied).toBe(true);
    const readEvent = events.find(
      (event) => event.type === "tool_result" && (event.payload as { call: ToolCall }).call.name === "read_file",
    );
    expect((readEvent?.payload as { result: ToolResult }).result.ok).toBe(true);
  });

  it("lets a before-tool hook block execution without firing after-tool hooks", async () => {
    const workspace = await makeWorkspace();
    const { executor, hookCalls, events, loopStub } = makeHarness(workspace, {
      tools: [makeTool("write_file", "write")],
      checkBeforeToolHook: async () => ({ ok: false, output: "", error: "blocked by policy", summary: "blocked" }),
    });
    const task = createTask(workspace, "hook block");
    const messages = runMessages();

    await executor.runTools(task, messages, [call("write_file", { path: "a.ts" })], loopStub);

    expect(messages[0]?.content).toBe("blocked by policy");
    const resultEvent = events.find((event) => event.type === "tool_result");
    expect((resultEvent?.payload as { result: ToolResult }).result.metadata).toBeUndefined();
    expect(hookCalls).toHaveLength(0);
  });

  it("starts a snapshot when an executable mutating tool is present", async () => {
    const workspace = await makeWorkspace();
    const snapshotStore = {
      begin: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
      undoLatest: vi.fn(),
      list: vi.fn(),
    };
    const { executor, loopStub } = makeHarness(workspace, {
      tools: [makeTool("write_file", "write")],
      snapshotStore: snapshotStore as unknown as SnapshotStorePort,
    });
    const task = createTask(workspace, "snapshot");
    await executor.runTools(task, [], [call("write_file", { path: "a.ts" })], loopStub);
    expect(snapshotStore.begin).toHaveBeenCalledWith("session-1", task);

    const readonlyOnly = makeHarness(workspace, { tools: [makeTool("read_file", "readonly")] });
    await readonlyOnly.executor.runTools(task, [], [call("read_file", { path: "a.ts" })], readonlyOnly.loopStub);
    expect(snapshotStore.begin).toHaveBeenCalledTimes(1);
  });
});

describe("ToolBatchExecutor readonly cache", () => {
  it("reuses cached readonly results across runs and clears after a successful mutation", async () => {
    const workspace = await makeWorkspace();
    const invoke = vi.fn(async () => ({ ok: true, output: "payload" }));
    const { executor, ports, loopStub } = makeHarness(workspace, {
      tools: [makeTool("read_file", "readonly", invoke), makeTool("write_file", "write")],
    });
    const task = createTask(workspace, "cache");
    const firstCall = call("read_file", { path: "a.ts" });

    await executor.runTools(task, [], [firstCall], loopStub);
    expect(invoke).toHaveBeenCalledTimes(1);

    const messages = runMessages();
    await executor.runTools(task, messages, [call("read_file", { path: "a.ts" })], loopStub);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(messages[0]?.content).toBe("payload");

    // A successful mutating tool invalidates the cache.
    await executor.runTools(task, [], [call("write_file", { path: "b.txt" })], loopStub);
    await executor.runTools(task, [], [call("read_file", { path: "a.ts" })], loopStub);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(ports.readonlyCache.size).toBe(1);
  });
});

describe("ToolBatchExecutor failure handling", () => {
  it("wraps thrown errors as failed tool results", async () => {
    const workspace = await makeWorkspace();
    const { executor, loopStub } = makeHarness(workspace, {
      tools: [
        makeTool("read_file", "readonly", async () => {
          throw new Error("disk full");
        }),
      ],
    });
    const task = createTask(workspace, "error");
    const messages = runMessages();

    await executor.runTools(task, messages, [call("read_file")], loopStub);
    expect(messages[0]).toMatchObject({ name: "read_file" });
    expect(messages[0]?.content).toBe("disk full");
  });

  it("reports cancellation for abort errors", async () => {
    const workspace = await makeWorkspace();
    const abortController = new AbortController();
    abortController.abort();
    const { executor, events, loopStub } = makeHarness(workspace, {
      tools: [
        makeTool("read_file", "readonly", async () => {
          throw new DOMException("operation aborted", "AbortError");
        }),
      ],
      getAbortSignal: () => abortController.signal,
    });
    const task = createTask(workspace, "cancelled");
    const messages = runMessages();

    await executor.runTools(task, messages, [call("read_file")], loopStub);
    const resultEvent = events.find((event) => event.type === "tool_result");
    const result = (resultEvent?.payload as { result: ToolResult }).result;
    expect(result).toMatchObject({ ok: false, error: "tool cancelled", summary: "cancelled" });
    expect(result.metadata?.cancelled).toBe(true);
  });

  it("fires after_tool_call hooks only for executed tools", async () => {
    const workspace = await makeWorkspace();
    const { executor, hookCalls, loopStub } = makeHarness(workspace, {
      tools: [makeTool("read_file", "readonly"), makeTool("write_file", "write")],
    });
    const task = createTask(workspace, "hooks");
    await executor.runTools(task, [], [call("read_file", { path: "a.ts" })], loopStub);
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]).toMatchObject({
      event: "after_tool_call",
      tool: expect.objectContaining({ name: "read_file" }),
    });
  });
});

describe("ToolBatchExecutor reconcileToolCalls", () => {
  it("synthesizes failed results for tool calls without a paired tool message", async () => {
    const workspace = await makeWorkspace();
    const { executor } = makeHarness(workspace);
    const task = createTask(workspace, "reconcile");
    const messages: Parameters<ToolBatchExecutor["reconcileToolCalls"]>[1] = [
      { role: "tool", content: "already recorded", toolCallId: "call_known", name: "read_file" },
    ];
    const calls = [call("read_file"), call("write_file")];
    calls[0]!.id = "call_known";

    await executor.reconcileToolCalls(task, messages, calls, "model stream interrupted", false);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "tool", toolCallId: "call_1", name: "write_file" });
    expect(messages[1]?.content).toBe("model stream interrupted");
  });

  it("labels reconciled entries as cancelled when the run was cancelled", async () => {
    const workspace = await makeWorkspace();
    const { executor } = makeHarness(workspace);
    const task = createTask(workspace, "reconcile cancelled");
    const messages: Parameters<ToolBatchExecutor["reconcileToolCalls"]>[1] = [];

    await executor.reconcileToolCalls(
      task,
      messages,
      [call("run_command", { command: "ls" })],
      "blocked before execution",
      true,
    );

    expect(messages[0]?.content).toBe("blocked before execution");
    expect(messages[0]).toMatchObject({ role: "tool" });
  });
});

describe("ToolBatchExecutor plan tracking and offload", () => {
  it("updates task plan state from update_plan results", async () => {
    const workspace = await makeWorkspace();
    const { executor, events, loopStub } = makeHarness(workspace, {
      tools: [
        makeTool("update_plan", "command", async () => ({
          ok: true,
          output: JSON.stringify({
            goal: "ship it",
            steps: [{ id: "1", title: "first", status: "in_progress" }],
            currentStepIndex: 0,
          }),
        })),
      ],
    });
    const task = createTask(workspace, "plan");
    const messages = runMessages();

    await executor.runTools(task, messages, [call("update_plan", { goal: "ship it" })], loopStub);

    expect(task.planState).toMatchObject({ goal: "ship it", currentStepIndex: 0 });
    expect(events.some((event) => event.type === "task_plan_updated")).toBe(true);
  });

  it("offloads oversized tool results and reports the compaction", async () => {
    const workspace = await makeWorkspace();
    const { executor, events, loopStub } = makeHarness(workspace, {
      tools: [makeTool("search_code", "readonly", async () => ({ ok: true, output: "x".repeat(60_000) }))],
      offload: async (candidates) => {
        const replacements = new Map<string, string>();
        for (const candidate of candidates) replacements.set(candidate.id, `[offloaded:${candidate.content.length}]`);
        return { replacements, offloadedCount: replacements.size, failedCount: 0 };
      },
    });
    const task = createTask(workspace, "offload");
    const messages = runMessages();

    await executor.runTools(task, messages, [call("search_code", { query: "needle" })], loopStub);

    expect(events.some((event) => event.type === "context_compaction")).toBe(true);
    expect(messages[0]?.content).toMatch(/^\[offloaded:\d+\]$/);
  });
});

describe("ToolBatchExecutor file change tracking", () => {
  it("records file hash transitions for write tools inside the workspace", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "a.ts"), "before", "utf8");
    const { executor, ports, loopStub } = makeHarness(workspace, {
      tools: [
        makeTool("write_file", "write", async () => {
          await writeFile(join(workspace, "a.ts"), "after-longer-content", "utf8");
          return { ok: true, output: "written" };
        }),
      ],
    });
    const task = createTask(workspace, "hash tracking");

    const summary = await executor.runTools(task, [], [call("write_file", { path: "a.ts" })], loopStub);

    expect(summary.workspaceMutated).toBe(true);
    expect(ports.trace.appendFileChange).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("a.ts"),
      expect.any(String),
      expect.any(String),
    );
  });
});

function makeBatchCall(steps: unknown[], onFailure?: "abort" | "continue"): ToolCall {
  const args: Record<string, unknown> = { steps };
  if (onFailure) args.on_failure = onFailure;
  return call("batch_tools", args);
}

/** 生产环境 batch_tools 由 registerBuiltinTools 必注册;测试 harness 里显式补上同形态桩。 */
function batchToolStub(): ToolDefinition {
  return { ...makeTool(BATCH_TOOL_NAME, "command"), permissionLevel: 0, system: true };
}

describe("ToolBatchExecutor batch_tools scripts", () => {
  it("runs steps in order, substitutes $ref outputs, and folds results into one message", async () => {
    const workspace = await makeWorkspace();
    const seen: unknown[] = [];
    const { executor, events, loopStub } = makeHarness(workspace, {
      tools: [
        batchToolStub(),
        makeTool("produce", "readonly", async () => ({ ok: true, output: '{"path":"src/a.ts"}' })),
        makeTool("consume", "readonly", async (invokeCall) => {
          seen.push(invokeCall.arguments);
          return { ok: true, output: "consumed" };
        }),
      ],
    });
    const task = createTask(workspace, "script happy path");
    const messages = runMessages();

    const summary = await executor.runTools(
      task,
      messages,
      [
        makeBatchCall([
          { id: "s1", tool: "produce", arguments: {} },
          { id: "s2", tool: "consume", arguments: { target: { $ref: "s1" }, note: "got-${s1}" } },
        ]),
      ],
      loopStub,
    );

    expect(summary).toEqual({ workspaceMutated: false, readonlyOnly: false });
    expect(seen).toEqual([{ target: { path: "src/a.ts" }, note: 'got-{"path":"src/a.ts"}' }]);

    // 折叠成一条 tool 消息,保持 assistant/toolCalls 配对不变式。
    expect(messages).toHaveLength(1);
    expect(messages[0]!.name).toBe("batch_tools");
    expect(messages[0]!.content).toContain("executed 2/2 step(s)");
    expect(messages[0]!.content).toContain("=== step s1 [produce] ok");
    expect(messages[0]!.content).toContain("=== step s2 [consume] ok");

    const starts = events.filter((event) => event.type === "tool_start");
    expect(starts.map((event) => (event.payload as { call: ToolCall }).call.name)).toEqual([
      "batch_tools",
      "produce",
      "consume",
    ]);
    const results = events.filter((event) => event.type === "tool_result");
    expect(results.map((event) => (event.payload as { call: ToolCall }).call.name)).toEqual([
      "produce",
      "consume",
      "batch_tools",
    ]);
    // 脚本调用 + 两个步骤都计入循环历史。
    expect(loopStub.record).toHaveBeenCalledTimes(3);
  });

  it("aborts at the first failed step by default and skips the remaining steps", async () => {
    const workspace = await makeWorkspace();
    const consume = vi.fn(async () => ({ ok: true, output: "never" }));
    const { executor, loopStub } = makeHarness(workspace, {
      tools: [
        batchToolStub(),
        makeTool("fail", "readonly", async () => ({ ok: false, output: "", error: "boom" })),
        makeTool("after", "readonly", consume),
      ],
    });
    const task = createTask(workspace, "script abort");
    const messages = runMessages();

    await executor.runTools(task, messages, [makeBatchCall([
      { id: "s1", tool: "fail", arguments: {} },
      { id: "s2", tool: "after", arguments: {} },
    ])], loopStub);

    expect(consume).not.toHaveBeenCalled();
    expect(messages[0]!.content).toContain('aborted at "s1" (on_failure=abort)');
    expect(messages[0]!.content).toContain("Remaining 1 step(s) skipped.");
    expect(messages[0]!.content).toContain("error: boom");
  });

  it("keeps executing remaining steps under the continue policy", async () => {
    const workspace = await makeWorkspace();
    const after = vi.fn(async () => ({ ok: true, output: "recovered" }));
    const { executor, loopStub } = makeHarness(workspace, {
      tools: [
        batchToolStub(),
        makeTool("fail", "readonly", async () => ({ ok: false, output: "", error: "boom" })),
        makeTool("after", "readonly", after),
      ],
    });
    const task = createTask(workspace, "script continue");
    const messages = runMessages();

    const summary = await executor.runTools(
      task,
      messages,
      [makeBatchCall([
        { id: "s1", tool: "fail", arguments: {} },
        { id: "s2", tool: "after", arguments: {} },
      ], "continue")],
      loopStub,
    );

    expect(after).toHaveBeenCalledTimes(1);
    expect(summary.workspaceMutated).toBe(false);
    expect(messages[0]!.content).toContain("executed 2/2 step(s), 1 failed");
    expect(messages[0]!.content).not.toContain("aborted");
  });

  it("records unknown step tools and reports them in the aggregate", async () => {
    const workspace = await makeWorkspace();
    const { executor, loopStub } = makeHarness(workspace, { tools: [batchToolStub()] });
    const task = createTask(workspace, "script unknown tool");
    const messages = runMessages();

    await executor.runTools(task, messages, [makeBatchCall([
      { id: "s1", tool: "does_not_exist", arguments: {} },
    ])], loopStub);

    expect(loopStub.recordUnknownTool).toHaveBeenCalledTimes(1);
    expect(messages[0]!.content).toContain("unknown tool: does_not_exist");
    expect(messages[0]!.content).toContain("aborted at \"s1\"");
  });

  it("enforces plan mode per step: readonly steps run, write steps are denied", async () => {
    const workspace = await makeWorkspace();
    const scribe = vi.fn(async () => ({ ok: true, output: "written" }));
    const { executor, loopStub } = makeHarness(workspace, {
      workMode: "plan",
      tools: [
        batchToolStub(),
        makeTool("probe", "readonly", async () => ({ ok: true, output: "inspected" })),
        makeTool("scribe", "write", scribe),
      ],
    });
    const task = createTask(workspace, "script plan mode");
    const messages = runMessages();

    await executor.runTools(task, messages, [makeBatchCall([
      { id: "s1", tool: "probe", arguments: {} },
      { id: "s2", tool: "scribe", arguments: {} },
    ])], loopStub);

    expect(scribe).not.toHaveBeenCalled();
    expect(messages[0]!.content).toContain("=== step s1 [probe] ok");
    expect(messages[0]!.content).toContain("plan mode only allows readonly tools and write_plan");
  });

  it("blocks a step when before_tool_call hook intercepts it", async () => {
    const workspace = await makeWorkspace();
    const guarded = vi.fn(async () => ({ ok: true, output: "ran" }));
    const { executor, loopStub } = makeHarness(workspace, {
      tools: [batchToolStub(), makeTool("guarded", "write", guarded)],
      checkBeforeToolHook: async (_task, hookCall) =>
        hookCall.name === "guarded"
          ? { ok: false, output: "", error: "blocked by policy", summary: "hook blocked" }
          : undefined,
    });
    const task = createTask(workspace, "script hook block");
    const messages = runMessages();

    await executor.runTools(task, messages, [makeBatchCall([
      { id: "s1", tool: "guarded", arguments: {} },
    ])], loopStub);

    expect(guarded).not.toHaveBeenCalled();
    expect(messages[0]!.content).toContain("error: blocked by policy");
  });

  it("rejects an invalid script without executing any step", async () => {
    const workspace = await makeWorkspace();
    const probe = vi.fn(async () => ({ ok: true, output: "ran" }));
    const { executor, events, loopStub } = makeHarness(workspace, {
      tools: [batchToolStub(), makeTool("probe", "readonly", probe)],
    });
    const task = createTask(workspace, "script invalid");
    const messages = runMessages();

    await executor.runTools(task, messages, [makeBatchCall([
      { tool: "probe", arguments: {} },
    ])], loopStub);

    expect(probe).not.toHaveBeenCalled();
    expect(loopStub.record).not.toHaveBeenCalled();
    expect(messages[0]!.name).toBe("batch_tools");
    expect(messages[0]!.content).toContain("steps[0].id");
    const resultEvent = events.find((event) => event.type === "tool_result");
    expect((resultEvent!.payload as { result: ToolResult }).result.error).toContain("steps[0].id");
  });
});
