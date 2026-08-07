import { afterEach, describe, expect, it, vi } from "vitest";
import { runTask } from "../src/agent.js";
import { ToolRegistry } from "../src/tools.js";
import type { AgentEvent, ModelConfig, ToolDefinition } from "../src/types.js";

const model: ModelConfig = {
  provider: "test",
  model: "test-model",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  temperature: 0.2,
  maxTokens: 1000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function eventsOfType(events: AgentEvent[], type: AgentEvent["type"]): AgentEvent[] {
  return events.filter((event) => event.type === type);
}

describe("runTask", () => {
  it("streams a normal assistant response and completes in one step", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
    }));
    const events: AgentEvent[] = [];

    await runTask({ workspace: "C:/workspace", prompt: "say hello", model, maxSteps: 3, approveAll: true, onEvent: (event) => events.push(event) }, new ToolRegistry());

    expect(requests).toHaveLength(1);
    expect(eventsOfType(events, "assistant_delta")).toEqual([{ type: "assistant_delta", text: "done" }]);
    expect(eventsOfType(events, "completed")).toEqual([{ type: "completed", steps: 1 }]);
  });

  it("preserves tool calls and continues with the tool result", async () => {
    const requests: Record<string, unknown>[] = [];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      callCount += 1;
      if (callCount === 1) {
        return response({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "workspace_echo", arguments: "{\"value\":\"ok\"}" } }],
            },
            finish_reason: "tool_calls",
          }],
        });
      }
      return response({ choices: [{ message: { role: "assistant", content: "verified" }, finish_reason: "stop" }] });
    }));
    const tool: ToolDefinition = {
      name: "workspace_echo",
      description: "Return the requested value.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      permissionLevel: 0,
      maxOutputChars: 1000,
      invoke: async (call) => ({ ok: true, output: String(call.arguments.value) }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const events: AgentEvent[] = [];

    await runTask({ workspace: "C:/workspace", prompt: "check it", model, maxSteps: 3, approveAll: true, onEvent: (event) => events.push(event) }, registry);

    expect(requests).toHaveLength(2);
    const secondMessages = requests[1]?.messages as Record<string, unknown>[];
    expect(secondMessages[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(secondMessages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "ok" });
    expect(eventsOfType(events, "tool_result")).toHaveLength(1);
    expect(eventsOfType(events, "completed")).toEqual([{ type: "completed", steps: 2 }]);
  });
});
