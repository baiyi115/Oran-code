import { describe, expect, it, vi } from "vitest";
import { errorPrefix, executeAction } from "../src/hook/actions.js";
import { evaluateCondition, parseCondition } from "../src/hook/condition.js";
import { HookEngine } from "../src/hook/engine.js";
import { extractHooks } from "../src/hook/config-loader.js";
import { HookNoticeQueue } from "../src/hook/notify-queue.js";
import type { HookConfig, HookEngineDeps, HookEventContext, HookResult } from "../src/hook/types.js";
import type { ToolCall } from "../src/types.js";

function context(overrides: Partial<HookEventContext> = {}): HookEventContext {
  return {
    event: "before_tool_call",
    ...overrides,
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, arguments: args, createdAt: "2026-08-28T00:00:00.000Z" };
}

function makeDeps(overrides: Partial<HookEngineDeps> = {}): HookEngineDeps & {
  runCommand: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  notices: HookNoticeQueue;
} {
  const notices = new HookNoticeQueue();
  return {
    notices,
    runCommand: vi.fn(async () => ({ ok: true, stdout: "hook stdout" })),
    fetch: vi.fn(async () => ({ ok: true, status: 200, body: "http body" })),
    ...overrides,
  } as HookEngineDeps & {
    runCommand: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
    notices: HookNoticeQueue;
  };
}

function makeEngine(configs: readonly HookConfig[], deps = makeDeps(), defaultCommandTimeoutMs = 1_000) {
  const engine = new HookEngine(configs, { ...deps, defaultCommandTimeoutMs });
  return { engine, deps };
}

describe("parseCondition", () => {
  it("parses a single clause with default all logic", () => {
    const condition = parseCondition("tool == read_file");
    expect(condition).toEqual({
      logic: "all",
      clauses: [{ field: "tool", operator: "==", negate: false, value: "read_file" }],
    });
  });

  it("parses && chains as all and || chains as any", () => {
    expect(parseCondition("tool == read_file && path =~ src/")?.logic).toBe("all");
    expect(parseCondition("tool == read_file || tool == glob_files")?.logic).toBe("any");
  });

  it("rejects mixed separators and invalid clauses", () => {
    expect(parseCondition("tool == read_file && path =~ a || b")).toBeUndefined();
    expect(parseCondition("")).toBeUndefined();
    expect(parseCondition("tool ==")).toBeUndefined();
    expect(parseCondition("nooperatorhere")).toBeUndefined();
  });

  it("parses negated clauses", () => {
    const condition = parseCondition("!tool == write_file");
    expect(condition?.clauses[0]).toMatchObject({ negate: true, field: "tool", operator: "==", value: "write_file" });
  });
});

describe("evaluateCondition", () => {
  it("treats a missing condition as always true", () => {
    expect(evaluateCondition(undefined, context())).toBe(true);
  });

  it.each([
    ["tool == read_file", "read_file", true],
    ["tool != read_file", "read_file", false],
    ["tool =~ ^read", "read_file", true],
    ["tool =~ ^READ", "read_file", true],
    ["tool glob read*", "read_file", true],
  ])("evaluates %s against tool %s", (expression, toolName, expected) => {
    expect(evaluateCondition(parseCondition(expression), context({ tool: toolCall(toolName) }))).toBe(expected);
  });

  it("reads standard fields from the context", () => {
    const ctx = context({
      event: "after_tool_call",
      tool: toolCall("write_file", { command: "ls -la" }),
      filePath: "src/a.ts",
      userPrompt: "fix it",
      workspace: "/tmp/ws",
      model: "test-model",
    });
    expect(evaluateCondition(parseCondition("event == after_tool_call"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("path == src/a.ts"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("userPrompt == fix it"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("workspace == /tmp/ws"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("model == test-model"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("command == ls -la"), ctx)).toBe(true);
  });

  it("reads the path field from filePath and falls back to tool argument fields", () => {
    const ctx = context({
      tool: toolCall("write_file", { limit: 5 }),
      filePath: "src/a.ts",
    });
    expect(evaluateCondition(parseCondition("path == src/a.ts"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("limit == 5"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("missing == anything"), ctx)).toBe(false);
  });

  it("treats an invalid regex as no match", () => {
    const condition = parseCondition("tool =~ ([");
    expect(evaluateCondition(condition, context({ tool: toolCall("read_file") }))).toBe(false);
  });

  it("combines clauses with all and any semantics", () => {
    const ctx = context({ tool: toolCall("read_file") });
    expect(evaluateCondition(parseCondition("tool == read_file && path == missing.ts"), ctx)).toBe(false);
    expect(evaluateCondition(parseCondition("tool == write_file || tool == read_file"), ctx)).toBe(true);
    expect(evaluateCondition(parseCondition("!tool == write_file && tool =~ file$"), ctx)).toBe(true);
  });
});

describe("HookEngine compilation", () => {
  it("accepts valid rules without errors", () => {
    const { engine } = makeEngine([
      { event: "after_tool_call", action: { type: "command", command: "echo done" } },
    ]);
    expect(engine.hasRules).toBe(true);
    expect(engine.getErrors()).toEqual([]);
  });

  it("collects validation errors for invalid rules without blocking later hooks", () => {
    const { engine } = makeEngine([
      { event: "not_an_event" as HookConfig["event"], action: { type: "command", command: "echo hi" } },
      { event: "turn_start", action: { type: "command", command: "  " } },
      { event: "turn_start", action: { type: "prompt", prompt: "" } },
      { event: "turn_start", action: { type: "http", url: "" } },
      { event: "turn_start", action: { type: "subagent" } },
      { event: "turn_start", action: { type: "command", command: "echo hi" }, intercept: true, async: true },
      { event: "turn_start", action: { type: "command", command: "echo hi" }, if: "just text" },
    ]);
    expect(engine.hasRules).toBe(false);
    const messages = engine.getErrors().map((error) => error.message);
    expect(messages.some((message) => message.includes("event must be one of"))).toBe(true);
    expect(messages).toContain("command action requires a non-empty command");
    expect(messages).toContain("prompt action requires a non-empty prompt");
    expect(messages).toContain("http action requires a non-empty url");
    expect(messages).toContain("subagent action requires a non-empty prompt or command");
    expect(messages).toContain("intercept and async are mutually exclusive");
    expect(messages.some((message) => message.includes("cannot parse condition expression"))).toBe(true);
  });
});

describe("HookEngine dispatch", () => {
  it("only runs rules matching the event and condition", async () => {
    const deps = makeDeps();
    const { engine } = makeEngine([
      { event: "turn_start", action: { type: "command", command: "echo matched" } },
      { event: "turn_start", if: "tool == write_file", action: { type: "command", command: "echo filtered" } },
      { event: "turn_end", action: { type: "command", command: "other event" } },
    ], deps);
    const results = await engine.dispatch(context({ event: "turn_start", tool: toolCall("read_file") }));
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toBe("hook stdout");
    expect(deps.runCommand).toHaveBeenCalledTimes(1);
    expect(deps.runCommand).toHaveBeenCalledWith("echo matched", expect.objectContaining({ HOOK_EVENT: "turn_start" }), 1_000);
  });

  it("fires once rules a single time until reset", async () => {
    const deps = makeDeps();
    const { engine } = makeEngine([
      { id: "notify-once", event: "turn_start", once: true, action: { type: "command", command: "echo once" } },
    ], deps);
    await engine.dispatch(context({ event: "turn_start" }));
    await engine.dispatch(context({ event: "turn_start" }));
    expect(deps.runCommand).toHaveBeenCalledTimes(1);
    engine.resetOnce();
    await engine.dispatch(context({ event: "turn_start" }));
    expect(deps.runCommand).toHaveBeenCalledTimes(2);
  });

  it("routes async rule output into the notice queue instead of results", async () => {
    const deps = makeDeps();
    const { engine } = makeEngine([
      { event: "turn_end", async: true, action: { type: "command", command: "echo async" } },
    ], deps);
    const results = await engine.dispatch(context({ event: "turn_end" }));
    expect(results).toEqual([]);
    await vi.waitFor(() => {
      expect(deps.notices.drain()).toEqual([{ event: "turn_end", text: "hook stdout" }]);
    });
  });

  it("reports async hook failures through the notice queue only under the fail policy", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => ({ ok: false, stdout: "" })),
    });
    const { engine } = makeEngine([
      { event: "turn_end", async: true, onError: "fail", action: { type: "command", command: "exit 1" } },
      { event: "turn_end", async: true, action: { type: "command", command: "exit 2" } },
    ], deps);
    await engine.dispatch(context({ event: "turn_end" }));
    await vi.waitFor(() => {
      expect(deps.notices.drain()).toEqual([
        { event: "turn_end", text: errorPrefix("hook turn_end:command failed") },
      ]);
    });
  });
});

describe("HookEngine dispatchBeforeTool", () => {
  it("stops dispatch and reports the intercept reason", async () => {
    const deps = makeDeps();
    const { engine } = makeEngine([
      { id: "guard", event: "before_tool_call", intercept: true, action: { type: "prompt", prompt: "blocked by policy" } },
      { event: "before_tool_call", action: { type: "command", command: "echo never" } },
    ], deps);
    const result = await engine.dispatchBeforeTool(context({ tool: toolCall("write_file") }));
    expect(result.intercepted).toBe(true);
    expect(result.interceptReason).toBe("blocked by policy");
    expect(result.results).toHaveLength(1);
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("never intercepts with async rules", async () => {
    const deps = makeDeps();
    const { engine } = makeEngine([
      { event: "before_tool_call", async: true, intercept: false, action: { type: "command", command: "echo side-effect" } },
    ], deps);
    const result = await engine.dispatchBeforeTool(context({ tool: toolCall("write_file") }));
    expect(result.intercepted).toBe(false);
    expect(result.results).toEqual([]);
    await vi.waitFor(() => expect(deps.notices.size).toBe(1));
  });

  it.each([
    ["ignore", { intercepted: false, resultCount: 0 }],
    ["fail", { intercepted: false, resultCount: 1 }],
    ["reject", { intercepted: true, resultCount: 1 }],
  ] as const)("applies the %s error policy to a failing command", async (onError, expected) => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => ({ ok: false, stdout: "exit 1" })),
    });
    const { engine } = makeEngine([
      { event: "before_tool_call", onError, action: { type: "command", command: "exit 1" } },
    ], deps);
    const result = await engine.dispatchBeforeTool(context({ tool: toolCall("write_file") }));
    expect(result.intercepted).toBe(expected.intercepted);
    expect(result.results).toHaveLength(expected.resultCount);
    if (expected.resultCount > 0) {
      expect(result.results[0]?.ok).toBe(false);
      // A non-empty command stdout is surfaced as-is.
      expect(result.results[0]?.output).toBe("exit 1");
    }
    if (onError === "reject") {
      expect(result.interceptReason).toBe("exit 1");
    }
  });

  it("synthesizes the error prefix when a failed command produced no stdout", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => ({ ok: false, stdout: "" })),
    });
    const { engine } = makeEngine([
      { event: "before_tool_call", onError: "fail", action: { type: "command", command: "exit 1" } },
    ], deps);
    const result = await engine.dispatchBeforeTool(context({ tool: toolCall("write_file") }));
    expect(result.results[0]?.output).toBe(errorPrefix("hook before_tool_call:command failed"));
  });
});

describe("executeAction", () => {
  it("passes command stdout through and injects hook env", async () => {
    const deps = makeDeps();
    const result = await executeAction(
      { type: "command", command: "echo hi" },
      context({ event: "after_tool_call", tool: toolCall("write_file"), filePath: "src/a.ts" }),
      deps,
      5_000,
      false,
    );
    expect(result).toMatchObject({ ok: true, output: "hook stdout" });
    expect(deps.runCommand).toHaveBeenCalledWith("echo hi", {
      HOOK_EVENT: "after_tool_call",
      HOOK_TOOL: "write_file",
      HOOK_FILE_PATH: "src/a.ts",
    }, 5_000);
  });

  it("returns the prompt output unchanged", async () => {
    const result = await executeAction(
      { type: "prompt", prompt: "please review" },
      context(),
      makeDeps(),
      1_000,
      true,
    );
    expect(result).toMatchObject({ ok: true, output: "please review", intercept: true });
  });

  it("posts event context to http actions and flags non-2xx as failure", async () => {
    const deps = makeDeps();
    const ok = await executeAction({ type: "http", url: "https://example.com/hook" }, context(), deps, 1_000, false);
    expect(ok).toMatchObject({ ok: true, output: "http body" });
    expect(deps.fetch).toHaveBeenCalledWith("https://example.com/hook", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
    }));

    const failing = makeDeps({
      fetch: vi.fn(async () => ({ ok: false, status: 500, body: "server error" })),
    });
    const failed = await executeAction({ type: "http", url: "https://example.com/hook" }, context(), failing, 1_000, false);
    expect(failed).toMatchObject({ ok: false, output: "HTTP 500: server error" });
  });

  it("requires a registered subagent executor", async () => {
    const missing = await executeAction(
      { type: "subagent", prompt: "explore" },
      context(),
      makeDeps(),
      1_000,
      false,
    );
    expect(missing).toMatchObject({ ok: false, output: errorPrefix("subagent executor not registered") });

    const executor = vi.fn(async (): Promise<HookResult> => ({ output: "subagent done", ok: true, intercept: false }));
    const registered = await executeAction(
      { type: "subagent", prompt: "explore" },
      context(),
      makeDeps({ subAgentExecutor: executor }),
      1_000,
      true,
    );
    expect(registered).toMatchObject({ ok: true, output: "subagent done", intercept: true });
    expect(executor).toHaveBeenCalledWith("explore", expect.anything());
  });

  it("converts thrown errors into prefixed failures", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
    });
    const result = await executeAction({ type: "command", command: "boom" }, context(), deps, 1_000, false);
    expect(result).toMatchObject({ ok: false, output: errorPrefix("spawn failed") });
  });
});

describe("extractHooks", () => {
  it("normalizes valid hook entries and flags", () => {
    const configs = extractHooks({
      hooks: [
        {
          id: " lint ",
          event: "after_tool_call",
          if: "tool == write_file",
          intercept: true,
          once: true,
          async: true,
          onError: "reject",
          action: { type: "command", command: "npm run lint", timeoutMs: 2_500, headers: { "x-a": "b" } },
        },
      ],
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      id: " lint ",
      event: "after_tool_call",
      if: "tool == write_file",
      intercept: true,
      once: true,
      async: true,
      onError: "reject",
    });
    expect(configs[0]?.action).toMatchObject({ type: "command", command: "npm run lint", timeoutMs: 2_500 });
  });

  it("drops non-object roots, non-array hooks and malformed entries", () => {
    expect(extractHooks(null)).toEqual([]);
    expect(extractHooks("hooks")).toEqual([]);
    expect(extractHooks({ hooks: "nope" })).toEqual([]);
    expect(extractHooks({ hooks: [null, "x", { event: "turn_start" }, { event: "turn_start", action: "nope" }] }))
      .toHaveLength(4);
    // Malformed entries become invalid configs that the engine rejects at compile time.
    const engine = new HookEngine(extractHooks({ hooks: [{ event: "turn_start" }] }), {
      ...makeDeps(),
      defaultCommandTimeoutMs: 1_000,
    });
    expect(engine.hasRules).toBe(false);
    expect(engine.getErrors().length).toBeGreaterThan(0);
  });
});

describe("HookNoticeQueue", () => {
  it("drains accumulated notices and clears the queue", () => {
    const queue = new HookNoticeQueue();
    expect(queue.size).toBe(0);
    queue.append({ event: "turn_start", text: "a" });
    queue.append({ event: "turn_end", text: "b" });
    expect(queue.size).toBe(2);
    expect(queue.drain()).toEqual([
      { event: "turn_start", text: "a" },
      { event: "turn_end", text: "b" },
    ]);
    expect(queue.size).toBe(0);
    queue.append({ event: "turn_start", text: "c" });
    queue.clear();
    expect(queue.drain()).toEqual([]);
  });
});
