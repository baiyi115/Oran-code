import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsParentContinuation, supportsTui, TerminalSession } from "../src/session.js";
import { JsonlEventLog } from "../src/headless-events.js";
import { parseSessionJsonl } from "../src/session-store.js";
import { userSessionsRoot } from "../src/paths.js";
import type { Message, ModelConfig, ModelProvider, ModelStreamChunk } from "../src/types.js";

const model: ModelConfig = {
  provider: "test",
  model: "test-model",
  temperature: 0.2,
  maxTokens: 1000,
};

function textChunks(text: string): ModelStreamChunk[] {
  const mid = Math.ceil(text.length / 2);
  return [
    { type: "text_delta", text: text.slice(0, mid), streamed: true },
    { type: "text_delta", text: text.slice(mid), streamed: true },
    { type: "response_complete", streamed: true, finishReason: "stop" },
  ];
}

class FakeProvider implements ModelProvider {
  readonly requests: Message[][] = [];
  async complete(): Promise<never> {
    throw new Error("complete should not be called by TerminalSession");
  }
  async *streamResponse(messages: Message[]): AsyncGenerator<ModelStreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })));
    for (const chunk of textChunks(`Plan: handle ${String(messages.at(-1)?.content ?? "")}.`)) yield chunk;
  }
}

/** Every test here builds a session against a real workspace and model catalog; alone that takes
 * under a second, but under the full suite one of them has timed out against vitest's 5s default. */
const SESSION_TEST_TIMEOUT_MS = 30_000;

describe("TerminalSession", { timeout: SESSION_TEST_TIMEOUT_MS }, () => {
  let originalUserDataDir: string | undefined;
  let testUserDataDir: string | undefined;

  beforeEach(async () => {
    originalUserDataDir = process.env.ORAN_USER_DATA_DIR;
    testUserDataDir = await mkdtemp(join(tmpdir(), "oran-test-session-userdata-"));
    process.env.ORAN_USER_DATA_DIR = testUserDataDir;
  });

  afterEach(async () => {
    if (originalUserDataDir !== undefined) process.env.ORAN_USER_DATA_DIR = originalUserDataDir;
    else delete process.env.ORAN_USER_DATA_DIR;
    if (testUserDataDir) await rm(testUserDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("selects the TUI only when both streams are TTYs", () => {
    const ttyInput = Object.assign(Readable.from([]), { isTTY: true });
    const nonTtyInput = Object.assign(Readable.from([]), { isTTY: false });
    const ttyOutput = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { isTTY: true },
    );
    const nonTtyOutput = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { isTTY: false },
    );

    expect(supportsTui(ttyInput, ttyOutput as NodeJS.WriteStream)).toBe(true);
    expect(supportsTui(nonTtyInput, ttyOutput as NodeJS.WriteStream)).toBe(false);
    expect(supportsTui(ttyInput, nonTtyOutput as NodeJS.WriteStream)).toBe(false);
  });

  it("continues the parent only for actionable child events", () => {
    expect(needsParentContinuation([{ status: "completed" }], [])).toBe(true);
    expect(needsParentContinuation([{ status: "failed" }], [])).toBe(true);
    expect(needsParentContinuation([{ status: "timed_out" }], [])).toBe(true);
    expect(needsParentContinuation([{ status: "cancelled" }], [])).toBe(false);
    expect(needsParentContinuation([], [{ kind: "question" }])).toBe(true);
    expect(needsParentContinuation([], [{ kind: "blocked" }])).toBe(true);
    expect(needsParentContinuation([], [{ kind: "result" }])).toBe(true);
    expect(needsParentContinuation([], [{ kind: "progress" }])).toBe(false);
    expect(needsParentContinuation([], [{ kind: "delivery_failed" }])).toBe(false);
  });

  it("rejects a task until the user explicitly selects a model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    let session: TerminalSession | undefined;
    try {
      session = new TerminalSession(
        {
          workspace,
          config: { providers: {} },
          approveAll: true,
        },
        process.stdin,
        process.stdout,
      );

      await expect(session.runOnce("do work")).rejects.toThrow("no model selected");
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // This case runs a full task through the session (real timers + readline); measured at close
  // to 5s when the whole suite runs in parallel, right at vitest's default timeout. It asserts
  // behavior, not speed, so it gets an explicit limit instead of turning red at random under load.
  it("selects a model from the freshly loaded project catalog", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    const projectConfig = join(workspace, ".oran", "config.json");
    const seenModels: ModelConfig[] = [];
    let session: TerminalSession | undefined;
    try {
      await mkdir(join(workspace, ".oran"), { recursive: true });
      await writeFile(
        projectConfig,
        JSON.stringify({
          providers: {
            demo: {
              options: { baseURL: "https://example.test/v1" },
              models: { chat: { options: { reasoningEffort: "high" } } },
            },
          },
        }),
        "utf8",
      );
      session = new TerminalSession(
        {
          workspace,
          config: { providers: {} },
          approveAll: true,
          providerFactory: (selected) => {
            seenModels.push(selected);
            return new FakeProvider();
          },
        },
        process.stdin,
        process.stdout,
      );

      await session.handleInput("/model demo/chat");
      const task = await session.runOnce("do work");

      expect(task.state).toBe("completed");
      expect(seenModels[0]).toMatchObject({
        provider: "demo",
        model: "chat",
        baseUrl: "https://example.test/v1",
        reasoningEffort: "high",
      });
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not auto-select a model when the catalog is opened", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    let session: TerminalSession | undefined;
    try {
      await mkdir(join(workspace, ".oran"), { recursive: true });
      await writeFile(
        join(workspace, ".oran", "config.json"),
        JSON.stringify({
          providers: { demo: { models: { chat: {} } } },
        }),
        "utf8",
      );
      session = new TerminalSession(
        {
          workspace,
          config: { providers: {} },
          approveAll: true,
        },
        process.stdin,
        process.stdout,
      );

      await session.handleInput("/model");

      await expect(session.runOnce("do work")).rejects.toThrow("no model selected");
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses an injected providerFactory for task execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    const provider = new FakeProvider();
    let session: TerminalSession | undefined;
    try {
      session = new TerminalSession(
        {
          workspace,
          model,
          config: { providers: {} },
          approveAll: true,
          providerFactory: () => provider,
        },
        process.stdin,
        process.stdout,
      );
      const task = await session.runOnce("add a test file");
      expect(task.state).toBe("completed");
      expect(task.result).toContain("Plan:");
      expect(task.plan).toBeUndefined();
      expect(provider.requests.length).toBeGreaterThanOrEqual(1);
      expect(provider.requests.every((messages) => messages[0]?.role === "system")).toBe(true);
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps scripted runs single-task when a child completion would schedule a continuation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-session-headless-continuation-"));
    const provider = new FakeProvider();
    const eventTypes: string[] = [];
    let activeAtCompletion = false;
    let continuationScheduled = false;
    let session: TerminalSession | undefined;
    try {
      session = new TerminalSession(
        {
          workspace,
          model,
          config: { providers: {} },
          approveAll: true,
          providerFactory: () => provider,
          runtimeEventSink: (event) => {
            eventTypes.push(event.type);
            if (event.type !== "completed") return;
            const internal = session as unknown as {
              currentSession?: { id: string };
              taskRunning(): boolean;
              scheduleAutoResume(sessionId: string): void;
              autoResumeScheduled: boolean;
            };
            activeAtCompletion = internal.taskRunning();
            internal.scheduleAutoResume(internal.currentSession!.id);
            continuationScheduled = internal.autoResumeScheduled;
          },
        },
        process.stdin,
        process.stdout,
      );

      const task = await session.runOnce("do work");
      expect(task.state).toBe("completed");
      expect(activeAtCompletion).toBe(true);
      expect(continuationScheduled).toBe(false);
      expect(provider.requests).toHaveLength(1);
      expect(eventTypes).toContain("completed");
      expect(eventTypes).not.toContain("assistant_abort");
      expect(eventTypes).not.toContain("cancelled");
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps headless terminal events and token buckets consistent across a tool turn", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-session-headless-log-"));
    const path = join(workspace, "events.jsonl");
    let log: JsonlEventLog | undefined;
    let session: TerminalSession | undefined;
    let modelCalls = 0;
    const provider: ModelProvider = {
      async complete() {
        throw new Error("not used");
      },
      async *streamResponse(): AsyncGenerator<ModelStreamChunk> {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            type: "tool_call_complete",
            toolCall: { index: 0, id: "call-1", name: "list_files", argumentsJson: '{"path":"."}' },
            streamed: true,
          };
          yield {
            type: "usage",
            usage: { prompt_tokens: 120, completion_tokens: 10, prompt_cache_hit_tokens: 80 },
            streamed: true,
          };
          yield { type: "response_complete", streamed: true, finishReason: "tool_calls" };
          return;
        }
        if (modelCalls !== 2) throw new Error("unexpected additional model request");
        yield { type: "text_delta", text: "done", streamed: true };
        yield {
          type: "usage",
          usage: { prompt_tokens: 150, completion_tokens: 20, prompt_cache_hit_tokens: 120 },
          streamed: true,
        };
        yield { type: "response_complete", streamed: true, finishReason: "stop" };
      },
    };

    try {
      log = JsonlEventLog.open(path, { model: "test/test-model", workspace, prompt: "do work", productVersion: "0" });
      session = new TerminalSession(
        {
          workspace,
          model,
          config: { providers: {} },
          approveAll: true,
          providerFactory: () => provider,
          runtimeEventSink: (event) => log?.record(event),
        },
        process.stdin,
        process.stdout,
      );
      const task = await session.runOnce("do work");
      expect(task.state).toBe("completed");
      expect(modelCalls).toBe(2);

      // Simulate the delegated task's terminal event without running a second model.
      log.record({
        version: 1,
        type: "subagent_usage",
        taskId: "subagent-fixture",
        sequence: 1,
        timestamp: new Date().toISOString(),
        name: "fixture",
        inputTokens: 60,
        outputTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      });
      await log.finish({ outcome: "completed", exitCode: 0, durationMs: 1, finalText: task.result ?? "" });

      const records = (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const runtimeEvents = records.filter((record) => record.kind === "runtime_event");
      expect(runtimeEvents.filter((event) => event.type === "completed")).toHaveLength(1);
      expect(runtimeEvents.some((event) => event.type === "assistant_abort" || event.type === "cancelled")).toBe(false);
      expect(records.at(-1)).toMatchObject({
        kind: "run_end",
        outcome: "completed",
        steps: 2,
        toolCalls: 1,
        tools: ["list_files"],
        mainTokens: { input: 270, output: 30, cacheRead: 200, cacheWrite: 0, total: 300 },
        subagentTokens: { input: 60, output: 5, cacheRead: 30, cacheWrite: 0, total: 65 },
        tokens: { input: 330, output: 35, cacheRead: 230, cacheWrite: 0, total: 365 },
      });
    } finally {
      await log?.finish({ outcome: "failed", exitCode: 1, durationMs: 1, finalText: "" }).catch(() => undefined);
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("appends the user message before the model request can complete", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-durable-user-"));
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: ModelProvider = {
      async complete() {
        throw new Error("not used");
      },
      async *streamResponse(messages: Message[]) {
        markStarted?.();
        await gate;
        for (const chunk of textChunks(`handled ${String(messages.at(-1)?.content ?? "")}`)) yield chunk;
      },
    };
    let session: TerminalSession | undefined;
    try {
      session = new TerminalSession(
        {
          workspace,
          model,
          config: { providers: {} },
          approveAll: true,
          providerFactory: () => provider,
        },
        process.stdin,
        process.stdout,
      );
      const taskPromise = session.runOnce("persist before response");
      await started;

      const sessionsDir = userSessionsRoot(workspace);
      const archives = await readdir(sessionsDir);
      const jsonlFile = archives.find((a) => a.endsWith(".jsonl"));
      expect(jsonlFile).toBeDefined();
      const records = parseSessionJsonl(await readFile(join(sessionsDir, jsonlFile!), "utf8"));
      expect(records.filter((record) => record.type === "message")).toEqual([
        expect.objectContaining({ role: "user", content: "User message:\npersist before response" }),
      ]);

      release?.();
      await expect(taskPromise).resolves.toMatchObject({ state: "completed" });
    } finally {
      release?.();
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rewinds the conversation to before an earlier user turn and records a session reset", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-session-rewind-"));
    let session: TerminalSession | undefined;
    try {
      session = new TerminalSession(
        {
          workspace,
          model,
          config: { providers: {} },
          approveAll: true,
          providerFactory: () => new FakeProvider(),
        },
        process.stdin,
        process.stdout,
      );
      await session.handleInput("/new");
      const internal = session as unknown as {
        conversation: Message[];
        rewindConversation(argument: string): Promise<{ ok: boolean; output: string }>;
      };
      internal.conversation = [
        { role: "user", content: "User message:\nfirst request" },
        { role: "assistant", content: "handled first request" },
        { role: "user", content: "[User steering guidance provided while task in progress]:\nkeep going" },
        { role: "assistant", content: "handled steering" },
        {
          role: "user",
          content: "[Previous task completed. New user task begins below.]\nUser message:\nsecond request",
        },
        { role: "assistant", content: "handled second request" },
      ];

      // With no argument it lists only the turns that can be rewound to (steering is not a separate turn).
      const listing = await internal.rewindConversation("");
      expect(listing.ok).toBe(true);
      expect(listing.output).toContain("1. first request");
      expect(listing.output).toContain("2. second request");
      expect(listing.output).not.toContain("keep going");

      const rewound = await internal.rewindConversation("2");
      expect(rewound.ok).toBe(true);
      expect(rewound.output).toContain("Rewound the conversation to before user turn 2");
      expect(internal.conversation.map((message) => message.content)).toEqual([
        "User message:\nfirst request",
        "handled first request",
        "[User steering guidance provided while task in progress]:\nkeep going",
        "handled steering",
      ]);

      // The rewind is persisted: the archive no longer contains the content of the dropped
      // turns, while the kept turns are still there.
      const sessionsDir = userSessionsRoot(workspace);
      const archives = (await readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl"));
      expect(archives.length).toBeGreaterThan(0);
      const archiveText = await readFile(join(sessionsDir, archives[0]!), "utf8");
      expect(parseSessionJsonl(archiveText).length).toBeGreaterThan(0);
      expect(archiveText).not.toContain("second request");
      expect(archiveText).toContain("first request");

      // Out-of-range and invalid arguments are explicitly rejected.
      const invalid = await internal.rewindConversation("9");
      expect(invalid.ok).toBe(false);
      expect(invalid.output).toContain("Invalid rewind target");
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("treats piped EOF as a normal session shutdown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    const input = Readable.from(["/model\n", "/clear\n"]);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let session: TerminalSession | undefined;
    try {
      session = new TerminalSession(
        {
          workspace,
          config: { providers: {} },
          approveAll: true,
        },
        input,
        output as NodeJS.WriteStream,
      );

      await expect(session.run()).resolves.toBeUndefined();
    } finally {
      await (session as any)?.shutdown?.().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
