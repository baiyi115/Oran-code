import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskController } from "../src/controller.js";
import { createRuntimeConfig } from "../src/runtime.js";
import { InMemoryTraceStore } from "../src/trace.js";
import { createTask } from "../src/types.js";
import { ToolRegistry } from "../src/tools.js";
import { Verifier } from "../src/verifier.js";
import type {
  HookEnginePort,
  Message,
  ModelConfig,
  ModelProvider,
  ModelResponse,
  ModelStreamChunk,
  RuntimeEvent,
  ToolCall,
  ToolDefinition,
  VerificationResult,
} from "../src/types.js";

const model: ModelConfig = {
  provider: "test",
  model: "test-model",
  temperature: 0.2,
  maxTokens: 1000,
};

class FakeProvider implements ModelProvider {
  readonly requests: Message[][] = [];
  private index = 0;

  constructor(private readonly responses: ModelStreamChunk[][]) {}

  async complete(): Promise<ModelResponse> {
    throw new Error("complete should not be called by TaskController");
  }

  async *streamResponse(messages: Message[]): AsyncGenerator<ModelStreamChunk> {
    this.requests.push(messages.map((message) => ({
      ...message,
      ...(message.toolCalls
        ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) }
        : {}),
    })));
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

function responseWithTrailingDelta(): ModelStreamChunk[] {
  return [
    { type: "text_delta", text: "done", streamed: true },
    { type: "response_complete", streamed: true, finishReason: "stop" },
    { type: "text_delta", text: "late", streamed: true },
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

interface ControllerTestOptions {
  approvalCallback?: (call: ToolCall, level: number, description: string, requestId: string) => boolean;
  hookEngine?: HookEnginePort;
  verifier?: Verifier;
}

function createController(
  workspace: string,
  provider: ModelProvider,
  registry: ToolRegistry,
  events: RuntimeEvent[],
  options: ControllerTestOptions = {},
): { controller: TaskController; trace: InMemoryTraceStore } {
  const trace = new InMemoryTraceStore();
  const controller = new TaskController({
    config: createRuntimeConfig(workspace, model, { providers: {}, agent: { maxSteps: 5, skipVerify: false } }, false),
    provider,
    registry,
    trace,
    ...(options.approvalCallback ? { approvalCallback: options.approvalCallback } : {}),
    ...(options.hookEngine ? { hookEngine: options.hookEngine } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
    eventCallback: (event) => { events.push(event); },
  });
  return { controller, trace };
}

class ScriptedVerifier extends Verifier {
  private index = 0;

  constructor(workspace: string, private readonly batches: VerificationResult[][]) {
    super(workspace);
  }

  override async runMany(): Promise<VerificationResult[]> {
    const batch = this.batches[this.index++];
    if (!batch) throw new Error("scripted verifier ran out of results");
    return batch;
  }
}

function verification(command: string, passed: boolean, output = passed ? "ok" : "failed"): VerificationResult {
  return { command, exitCode: passed ? 0 : 1, output, durationMs: 1, passed };
}

describe("TaskController", () => {
  it("answers ordinary chat directly without a plan step or verification", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
    try {
      const provider = new FakeProvider([textResponse("Hi! How can I help?")]);
      const registry = new ToolRegistry();
      const events: RuntimeEvent[] = [];
      const { controller, trace } = createController(workspace, provider, registry, events);

      const task = await controller.execute(createTask(workspace, "hi"));

      expect(task.state).toBe("completed");
      expect(task.plan).toBeUndefined();
      expect(task.result).toBe("Hi! How can I help?");
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.some((message) => typeof message.content === "string" && message.content.includes("User message:\nhi"))).toBe(true);
      expect(events.some((event) => event.type === "plan")).toBe(false);
      expect(events.some((event) => event.type === "approval_request")).toBe(false);
      expect(trace.exportTrace(task.id).steps.map((step) => step.kind)).toEqual(["context", "model_request", "model_response"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("streams, invokes a tool, verifies, and persists the trace without a plan step", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
    try {
      const registry = new ToolRegistry();
      const tool: ToolDefinition = {
        name: "custom_writer",
        description: "Write a note in the workspace.",
        parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
        permissionLevel: 2,
        maxOutputChars: 1000,
        invoke: async (call) => {
          await writeFile(join(workspace, "note.txt"), String(call.arguments.content), "utf8");
          return { ok: true, output: "wrote note.txt" };
        },
      };
      registry.register(tool);
    const call: ToolCall = { id: "call_1", name: "custom_writer", arguments: { content: "hello" }, createdAt: new Date().toISOString() };
     // fixture mismatch fix: align tool call name with registered tool
     const provider = new FakeProvider([
        toolResponse(call),
        textResponse("Done. The note was written."),
      ]);
      const events: RuntimeEvent[] = [];
      const { controller, trace } = createController(workspace, provider, registry, events, { approvalCallback: () => true });

      const task = await controller.execute(createTask(workspace, "write a note"));

      expect(task.state).toBe("completed");
      expect(task.plan).toBeUndefined();
      expect(task.result).toBe("Done. The note was written.");
      await expect(readFile(join(workspace, "note.txt"), "utf8")).resolves.toBe("hello");
      expect(events.filter((event) => event.type === "assistant_delta").map((event) => event.text)).toEqual([
        "Done. The note",
        " was written.",
      ]);
      expect(events.some((event) => event.type === "plan")).toBe(false);
      expect(events.some((event) => event.type === "tool_result" && event.result.ok)).toBe(true);
      const exported = trace.exportTrace(task.id);
      expect(exported.task.state).toBe("completed");
      expect(exported.toolCalls).toHaveLength(1);
      expect(exported.toolCalls[0]).toMatchObject({ name: "custom_writer", ok: 1 });
      expect(provider.requests[1]?.some((message) => message.role === "tool" && message.toolCallId === "call_1" && message.content === "wrote note.txt")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records a rejected approval and still lets the model finish", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
    try {
      const registry = new ToolRegistry();
      let invoked = false;
      registry.register({
        name: "dangerous_change",
        description: "Make a change.",
        parameters: { type: "object", properties: {} },
        permissionLevel: 2,
        maxOutputChars: 1000,
        invoke: async () => {
          invoked = true;
          return { ok: true, output: "changed" };
        },
      });
      const call: ToolCall = { id: "call_rejected", name: "dangerous_change", arguments: {}, createdAt: new Date().toISOString() };
      const provider = new FakeProvider([
        toolResponse(call),
        textResponse("I could not make the change without approval."),
      ]);
      const events: RuntimeEvent[] = [];
      const { controller, trace } = createController(workspace, provider, registry, events, {
        approvalCallback: (call) => call.name === "__plan__",
      });

      const task = await controller.execute(createTask(workspace, "make a change"));

      expect(task.state).toBe("completed");
      expect(invoked).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "approval_request", call: expect.objectContaining({ name: "dangerous_change" }) }));
      expect(events.some((event) => event.type === "approval_request" && event.call.name === "__plan__")).toBe(false);
      expect(events.some((event) => event.type === "plan")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", result: expect.objectContaining({ ok: false }) }));
      expect(trace.exportTrace(task.id).toolCalls[0]).toMatchObject({ name: "dangerous_change", ok: 0 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects provider output emitted after response_complete", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
    try {
      const provider = new FakeProvider([responseWithTrailingDelta()]);
      const events: RuntimeEvent[] = [];
      const { controller } = createController(workspace, provider, new ToolRegistry(), events);

      await expect(controller.execute(createTask(workspace, "hi")))
        .rejects.toThrow("provider emitted text_delta after response_complete");
      expect(events.find((event) => event.type === "error")?.message).toBe(
        "provider emitted text_delta after response_complete",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("pairs turn hooks when an ordinary response completes the task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
    try {
      const hookEvents: string[] = [];
      const hookEngine: HookEnginePort = {
        hasRules: true,
        getErrors: () => [],
        dispatch: async (context) => { hookEvents.push(context.event); },
        dispatchBeforeTool: async () => ({ intercepted: false }),
        drainNotices: () => [],
        resetOnce: () => undefined,
      };
      const provider = new FakeProvider([textResponse("Hello")]);
      const { controller } = createController(workspace, provider, new ToolRegistry(), [], { hookEngine });

      await controller.execute(createTask(workspace, "hi"));

      expect(hookEvents.filter((event) => event === "turn_start" || event === "turn_end"))
        .toEqual(["turn_start", "turn_end"]);
      expect(hookEvents.at(-1)).toBe("session_end");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("feeds a later verification failure back to the model before completing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
    try {
      const registry = new ToolRegistry();
      registry.register({
        name: "write_file",
        description: "Write a note in the workspace.",
        parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
        permissionLevel: 2,
        kind: "write",
        maxOutputChars: 1000,
        invoke: async (call) => {
          await writeFile(join(workspace, "note.txt"), String(call.arguments.content), "utf8");
          return { ok: true, output: "wrote note.txt" };
        },
      });
      const provider = new FakeProvider([
        toolResponse({ id: "call_verify", name: "write_file", arguments: { content: "hello" }, createdAt: new Date().toISOString() }),
        textResponse("The change is ready."),
        textResponse("The verification failure is fixed."),
      ]);
      const verifier = new ScriptedVerifier(workspace, [
        [verification("typecheck", true), verification("build", false, "build failed")],
        [verification("typecheck", true), verification("build", true)],
      ]);
      const events: RuntimeEvent[] = [];
      const { controller } = createController(workspace, provider, registry, events, {
        approvalCallback: () => true,
        verifier,
      });

      const task = await controller.execute(createTask(workspace, "write and verify a note"));

      expect(task.state).toBe("completed");
      expect(task.result).toBe("The verification failure is fixed.");
      expect(provider.requests).toHaveLength(3);
      expect(provider.requests[2]?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("build failed"))).toBe(true);
      const verifyEvents = events.filter((event): event is Extract<RuntimeEvent, { type: "verify" }> => event.type === "verify");
      expect(verifyEvents).toHaveLength(2);
      expect(verifyEvents[0]?.results).toEqual([
        verification("typecheck", true),
        verification("build", false, "build failed"),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
