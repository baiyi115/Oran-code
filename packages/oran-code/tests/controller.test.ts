import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskController } from "../src/controller.js";
import { createRuntimeConfig } from "../src/runtime.js";
import { InMemoryTraceStore } from "../src/trace.js";
import { createTask } from "../src/types.js";
import { ToolRegistry } from "../src/tools.js";
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
    this.requests.push(
      messages.map((message) => ({
        ...message,
        ...(message.toolCalls
          ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) }
          : {}),
      })),
    );
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

/** Arguments are complete, but finish_reason says the output was cut by the limit: the call fails and must not run. */
function truncatedToolResponse(call: ToolCall): ModelStreamChunk[] {
  return [
    { type: "text_delta", text: "Let me write the file", streamed: true },
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
    { type: "response_complete", streamed: true, finishReason: "length" },
  ];
}

/** Plain text was truncated (no tool calls at all): the text is answer content and can join continuation assembly. */
function truncatedTextResponse(text: string): ModelStreamChunk[] {
  return [
    { type: "text_delta", text, streamed: true },
    { type: "response_complete", streamed: true, finishReason: "length" },
  ];
}

/** Truncated with nothing received at all (e.g. cut off during the reasoning phase). */
function emptyTruncatedResponse(): ModelStreamChunk[] {
  return [{ type: "response_complete", streamed: true, finishReason: "length" }];
}

interface ControllerTestOptions {
  approvalCallback?: (call: ToolCall, level: number, description: string, requestId: string) => boolean;
  hookEngine?: HookEnginePort;
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
    eventCallback: (event) => {
      events.push(event);
    },
  });
  return { controller, trace };
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
      expect(
        provider.requests[0]?.some(
          (message) => typeof message.content === "string" && message.content.includes("User message:\nhi"),
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "plan")).toBe(false);
      expect(events.some((event) => event.type === "approval_request")).toBe(false);
      expect(trace.exportTrace(task.id).steps.map((step) => step.kind)).toEqual([
        "context",
        "model_request",
        "model_response",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  describe("readonly tool caching", () => {
    it("invokes a cacheable:false readonly tool for repeated identical calls", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const registry = new ToolRegistry();
        let invokeCount = 0;
        registry.register({
          name: "live_status",
          description: "Read live status.",
          parameters: { type: "object", properties: { scope: { type: "string" } }, required: ["scope"] },
          permissionLevel: 0,
          kind: "readonly",
          cacheable: false,
          maxOutputChars: 1000,
          invoke: async () => ({ ok: true, output: `status-${++invokeCount}` }),
        });
        const provider = new FakeProvider([
          toolResponse({
            id: "call_live_1",
            name: "live_status",
            arguments: { scope: "tasks" },
            createdAt: new Date().toISOString(),
          }),
          toolResponse({
            id: "call_live_2",
            name: "live_status",
            arguments: { scope: "tasks" },
            createdAt: new Date().toISOString(),
          }),
          textResponse("Status refreshed."),
        ]);
        const events: RuntimeEvent[] = [];
        const { controller } = createController(workspace, provider, registry, events);

        const task = await controller.execute(createTask(workspace, "refresh status twice"));

        expect(task.state).toBe("completed");
        expect(invokeCount).toBe(2);
        expect(events.filter((event) => event.type === "tool_result").map((event) => event.result.output)).toEqual([
          "status-1",
          "status-2",
        ]);
        expect(events.some((event) => event.type === "tool_result" && event.result.metadata?.cached === true)).toBe(
          false,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    it("caches repeated identical readonly calls by default", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const registry = new ToolRegistry();
        let invokeCount = 0;
        registry.register({
          name: "stable_status",
          description: "Read stable status.",
          parameters: { type: "object", properties: { scope: { type: "string" } }, required: ["scope"] },
          permissionLevel: 0,
          kind: "readonly",
          maxOutputChars: 1000,
          invoke: async () => ({ ok: true, output: `status-${++invokeCount}` }),
        });
        const provider = new FakeProvider([
          toolResponse({
            id: "call_stable_1",
            name: "stable_status",
            arguments: { scope: "tasks" },
            createdAt: new Date().toISOString(),
          }),
          toolResponse({
            id: "call_stable_2",
            name: "stable_status",
            arguments: { scope: "tasks" },
            createdAt: new Date().toISOString(),
          }),
          textResponse("Status reused."),
        ]);
        const events: RuntimeEvent[] = [];
        const { controller } = createController(workspace, provider, registry, events);

        const task = await controller.execute(createTask(workspace, "read status twice"));

        expect(task.state).toBe("completed");
        expect(invokeCount).toBe(1);
        expect(events.filter((event) => event.type === "tool_result").map((event) => event.result.output)).toEqual([
          "status-1",
          "status-1",
        ]);
        expect(
          events.filter((event) => event.type === "tool_result").map((event) => event.result.metadata?.cached === true),
        ).toEqual([false, true]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
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
      const call: ToolCall = {
        id: "call_1",
        name: "custom_writer",
        arguments: { content: "hello" },
        createdAt: new Date().toISOString(),
      };
      // fixture mismatch fix: align tool call name with registered tool
      const provider = new FakeProvider([toolResponse(call), textResponse("Done. The note was written.")]);
      const events: RuntimeEvent[] = [];
      const { controller, trace } = createController(workspace, provider, registry, events, {
        approvalCallback: () => true,
      });

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
      expect(
        provider.requests[1]?.some(
          (message) =>
            message.role === "tool" && message.toolCallId === "call_1" && message.content === "wrote note.txt",
        ),
      ).toBe(true);
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
      const call: ToolCall = {
        id: "call_rejected",
        name: "dangerous_change",
        arguments: {},
        createdAt: new Date().toISOString(),
      };
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
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "approval_request",
          call: expect.objectContaining({ name: "dangerous_change" }),
        }),
      );
      expect(events.some((event) => event.type === "approval_request" && event.call.name === "__plan__")).toBe(false);
      expect(events.some((event) => event.type === "plan")).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_result", result: expect.objectContaining({ ok: false }) }),
      );
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

      await expect(controller.execute(createTask(workspace, "hi"))).rejects.toThrow(
        "provider emitted text_delta after response_complete",
      );
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
        dispatch: async (context) => {
          hookEvents.push(context.event);
        },
        dispatchBeforeTool: async () => ({ intercepted: false }),
        drainNotices: () => [],
        resetOnce: () => undefined,
      };
      const provider = new FakeProvider([textResponse("Hello")]);
      const { controller } = createController(workspace, provider, new ToolRegistry(), [], { hookEngine });

      await controller.execute(createTask(workspace, "hi"));

      expect(hookEvents.filter((event) => event === "turn_start" || event === "turn_end")).toEqual([
        "turn_start",
        "turn_end",
      ]);
      expect(hookEvents.at(-1)).toBe("session_end");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  describe("truncated model output", () => {
    it("discards tool calls from a truncated response and asks the model to continue", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const registry = new ToolRegistry();
        let invoked = false;
        registry.register({
          name: "custom_writer",
          description: "Write a note in the workspace.",
          parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
          permissionLevel: 2,
          kind: "write",
          maxOutputChars: 1000,
          invoke: async () => {
            invoked = true;
            return { ok: true, output: "wrote note.txt" };
          },
        });
        const provider = new FakeProvider([
          truncatedToolResponse({
            id: "call_truncated",
            name: "custom_writer",
            arguments: { content: "hello" },
            createdAt: new Date().toISOString(),
          }),
          textResponse("Recovered with a smaller step."),
        ]);
        const events: RuntimeEvent[] = [];
        const { controller } = createController(workspace, provider, registry, events, {
          approvalCallback: () => true,
        });

        const task = await controller.execute(createTask(workspace, "write a note"));

        expect(task.state).toBe("completed");
        expect(task.result).toBe("Recovered with a smaller step.");
        expect(invoked).toBe(false);
        expect(events.some((event) => event.type === "tool_result")).toBe(false);
        // The truncation notice reaches the logger channel as a real log event
        // (the TUI could not see it before).
        expect(
          events.some(
            (event) => event.type === "log" && typeof event.message === "string" && event.message.includes("truncated"),
          ),
        ).toBe(true);
        expect(
          provider.requests[1]?.some(
            (message) =>
              typeof message.content === "string" && message.content.includes("cut off by the output token limit"),
          ),
        ).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    it("continues a truncated text answer and assembles both parts into the result", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const provider = new FakeProvider([
          truncatedTextResponse("# Design\n\nThe first half of the answer"),
          textResponse("and the second half."),
        ]);
        const events: RuntimeEvent[] = [];
        const { controller, trace } = createController(workspace, provider, new ToolRegistry(), events);

        const task = await controller.execute(createTask(workspace, "write the design doc"));

        expect(task.state).toBe("completed");
        expect(task.result).toBe("# Design\n\nThe first half of the answer\n\nand the second half.");
        // The continuation request carries a "keep writing, do not restate" instruction and
        // reports how many characters have been received so far.
        expect(
          provider.requests[1]?.some(
            (message) => typeof message.content === "string" && /about \d+ characters so far/.test(message.content),
          ),
        ).toBe(true);
        // The trace shows this continuation, including the character count received and
        // whether it was a plain-text truncation.
        expect(trace.exportTrace(task.id).steps.map((step) => step.kind)).toContain("model_truncated");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    it("keeps the partial answer instead of failing when text truncation repeats", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const provider = new FakeProvider([
          truncatedTextResponse("chunk one"),
          truncatedTextResponse("chunk two"),
          truncatedTextResponse("chunk three"),
        ]);
        const events: RuntimeEvent[] = [];
        const { controller } = createController(workspace, provider, new ToolRegistry(), events);

        const task = await controller.execute(createTask(workspace, "write a long answer"));

        expect(task.state).toBe("completed");
        expect(task.result).toContain("chunk one");
        expect(task.result).toContain("chunk two");
        expect(task.result).toContain("chunk three");
        expect(task.result).toContain("the text above is incomplete");
        // The finish state is completed, but the generated content is no longer thrown away
        // as part of a "task failure".
        expect(events.some((event) => event.type === "error")).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    it("still fails when every truncated response was empty", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const provider = new FakeProvider([
          emptyTruncatedResponse(),
          emptyTruncatedResponse(),
          emptyTruncatedResponse(),
        ]);
        const events: RuntimeEvent[] = [];
        const { controller } = createController(workspace, provider, new ToolRegistry(), events);

        const task = await controller.execute(createTask(workspace, "answer something"));

        expect(task.state).toBe("failed");
        expect(events.find((event) => event.type === "error")?.message).toContain("no partial answer was received");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    it("fails the task after repeated truncation instead of retrying forever", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "liteagent-controller-"));
      try {
        const registry = new ToolRegistry();
        let invoked = false;
        registry.register({
          name: "custom_writer",
          description: "Write a note in the workspace.",
          parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
          permissionLevel: 2,
          kind: "write",
          maxOutputChars: 1000,
          invoke: async () => {
            invoked = true;
            return { ok: true, output: "wrote note.txt" };
          },
        });
        const truncated = () =>
          truncatedToolResponse({
            id: "call_truncated",
            name: "custom_writer",
            arguments: { content: "hello" },
            createdAt: new Date().toISOString(),
          });
        const provider = new FakeProvider([truncated(), truncated(), truncated(), truncated()]);
        const events: RuntimeEvent[] = [];
        const { controller } = createController(workspace, provider, registry, events, {
          approvalCallback: () => true,
        });

        const task = await controller.execute(createTask(workspace, "write a note"));

        expect(task.state).toBe("failed");
        expect(invoked).toBe(false);
        expect(events.some((event) => event.type === "tool_result")).toBe(false);
        expect(events.find((event) => event.type === "error")?.message).toContain("output token limit");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  it("completes directly when the model responds without running implicit verification", async () => {
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
        toolResponse({
          id: "call_verify",
          name: "write_file",
          arguments: { content: "hello" },
          createdAt: new Date().toISOString(),
        }),
        textResponse("The change is ready."),
      ]);
      const events: RuntimeEvent[] = [];
      const { controller } = createController(workspace, provider, registry, events, {
        approvalCallback: () => true,
      });

      const task = await controller.execute(createTask(workspace, "write a note"));

      expect(task.state).toBe("completed");
      expect(task.result).toBe("The change is ready.");
      expect(provider.requests).toHaveLength(2);
      const verifyEvents = events.filter(
        (event): event is Extract<RuntimeEvent, { type: "verify" }> => event.type === "verify",
      );
      expect(verifyEvents).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
