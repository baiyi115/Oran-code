import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { supportsTui, TerminalSession } from "../src/session.js";
import { parseSessionJsonl } from "../src/session-store.js";
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
    { text: text.slice(0, mid), streamed: true },
    { text: text.slice(mid), streamed: true, finishReason: "stop" },
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

describe("TerminalSession", () => {
  it("selects the TUI only when both streams are TTYs", () => {
    const ttyInput = Object.assign(Readable.from([]), { isTTY: true });
    const nonTtyInput = Object.assign(Readable.from([]), { isTTY: false });
    const ttyOutput = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { isTTY: true });
    const nonTtyOutput = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { isTTY: false });

    expect(supportsTui(ttyInput, ttyOutput as NodeJS.WriteStream)).toBe(true);
    expect(supportsTui(nonTtyInput, ttyOutput as NodeJS.WriteStream)).toBe(false);
    expect(supportsTui(ttyInput, nonTtyOutput as NodeJS.WriteStream)).toBe(false);
  });

  it("rejects a task until the user explicitly selects a model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    try {
      const session = new TerminalSession({
        workspace,
        config: { providers: {} },
        approveAll: true,
      }, process.stdin, process.stdout);

      await expect(session.runOnce("do work")).rejects.toThrow("no model selected");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("selects a model from the freshly loaded project catalog", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    const projectConfig = join(workspace, ".oran", "config.json");
    const seenModels: ModelConfig[] = [];
    try {
      await mkdir(join(workspace, ".oran"), { recursive: true });
      await writeFile(projectConfig, JSON.stringify({
        providers: {
          demo: {
            options: { baseURL: "https://example.test/v1" },
            models: { chat: { options: { reasoningEffort: "high" } } },
          },
        },
      }), "utf8");
      const session = new TerminalSession({
        workspace,
        config: { providers: {} },
        approveAll: true,
        providerFactory: (selected) => {
          seenModels.push(selected);
          return new FakeProvider();
        },
      }, process.stdin, process.stdout);

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
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not auto-select a model when the catalog is opened", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    try {
      await mkdir(join(workspace, ".oran"), { recursive: true });
      await writeFile(join(workspace, ".oran", "config.json"), JSON.stringify({
        providers: { demo: { models: { chat: {} } } },
      }), "utf8");
      const session = new TerminalSession({
        workspace,
        config: { providers: {} },
        approveAll: true,
      }, process.stdin, process.stdout);

      await session.handleInput("/model");

      await expect(session.runOnce("do work")).rejects.toThrow("no model selected");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses an injected providerFactory for task execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    const provider = new FakeProvider();
    try {
      const session = new TerminalSession(
        {
          workspace,
          model,
          config: { providers: {}, agent: { maxSteps: 10, skipVerify: false } },
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
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("appends the user message before the model request can complete", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-durable-user-"));
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: ModelProvider = {
      async complete() { throw new Error("not used"); },
      async *streamResponse(messages: Message[]) {
        markStarted?.();
        await gate;
        for (const chunk of textChunks(`handled ${String(messages.at(-1)?.content ?? "")}`)) yield chunk;
      },
    };
    try {
      const session = new TerminalSession({
        workspace,
        model,
        config: { providers: {}, agent: { maxSteps: 2, skipVerify: false } },
        approveAll: true,
        providerFactory: () => provider,
      }, process.stdin, process.stdout);
      const taskPromise = session.runOnce("persist before response");
      await started;

      const archives = await readdir(join(workspace, ".oran", "sessions"));
      const records = parseSessionJsonl(await readFile(join(workspace, ".oran", "sessions", archives[0]!), "utf8"));
      expect(records.filter((record) => record.type === "message")).toEqual([
        expect.objectContaining({ role: "user", content: "User message:\npersist before response" }),
      ]);

      release?.();
      await expect(taskPromise).resolves.toMatchObject({ state: "completed" });
    } finally {
      release?.();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("treats piped EOF as a normal session shutdown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-session-"));
    const input = Readable.from(["/model\n", "/clear\n"]);
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    try {
      const session = new TerminalSession({
        workspace,
        config: { providers: {} },
        approveAll: true,
      }, input, output as NodeJS.WriteStream);

      await expect(session.run()).resolves.toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
