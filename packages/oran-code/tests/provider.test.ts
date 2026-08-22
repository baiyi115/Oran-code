import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider, OpenAICompatibleProvider } from "../src/provider.js";
import type { Message, ModelConfig } from "../src/types.js";

const messages: Message[] = [{ role: "user", content: "hello" }];

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: "demo",
    model: "demo-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    temperature: 0.2,
    maxTokens: 1024,
    ...overrides,
  };
}

function sseResponse(payload: string, splitEveryByte = false): Response {
  const bytes = new TextEncoder().encode(payload);
  const chunks: Uint8Array[] = [];
  if (splitEveryByte) {
    for (const byte of bytes) chunks.push(Uint8Array.of(byte));
  } else {
    chunks.push(bytes);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleProvider", () => {
  it("sends provider/model options without leaking local-only fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new OpenAICompatibleProvider(model({
      reasoningEffort: "high",
      options: {
        response_format: { type: "json_object" },
        permission: "allow",
        baseURL: "https://should-not-win.example",
        temperature: 9,
        max_tokens: 99,
      },
    }));

    await provider.complete(messages);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "demo-chat",
      temperature: 0.2,
      max_tokens: 1024,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("reasoningEffort");
    expect(body).not.toHaveProperty("permission");
    expect(body).not.toHaveProperty("baseURL");
    expect(body).not.toHaveProperty("apiKey");
  });

  it("supports a base URL that already points to chat completions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new OpenAICompatibleProvider(model({ baseUrl: "https://example.test/v1/chat/completions" }));

    await provider.complete(messages);

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe("https://example.test/v1/chat/completions");
  });

  it("keeps SSE tail bytes, usage, reasoning, and tool-call index order", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你", reasoning_content: "think" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_second", function: { name: "second", arguments: '{"value":2}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_first", function: { name: "first", arguments: '{"value":1}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 }, choices: [] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
    ].join(""), true));

    const chunks = await collect(new OpenAICompatibleProvider(model()).streamResponse(messages));
    const completedCalls = chunks.filter((chunk) => chunk.type === "tool_call_complete");
    const completed = chunks.find((chunk) => chunk.type === "response_complete");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(chunks.filter((chunk) => chunk.type === "text_delta").map((chunk) => chunk.text).join("")).toBe("你");
    expect(chunks.filter((chunk) => chunk.type === "reasoning_delta").map((chunk) => chunk.text).join("")).toBe("think");
    expect(chunks.find((chunk) => chunk.type === "usage" && chunk.usage.prompt_tokens === 3)).toMatchObject({ usage: { prompt_tokens: 3, completion_tokens: 4 } });
    expect(completed).toMatchObject({ type: "response_complete", finishReason: "tool_calls" });
    expect(completedCalls.map((chunk) => chunk.toolCall.name)).toEqual(["first", "second"]);
    expect(completedCalls.map((chunk) => chunk.toolCall.id)).toEqual(["call_first", "call_second"]);
    expect(completedCalls.map((chunk) => chunk.toolCall.argumentsJson)).toEqual(['{"value":1}', '{"value":2}']);
  });

  it("emits response_complete only after finish_reason and trailing usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 }, choices: [] })}\n\n`,
    ].join("")));

    const chunks = await collect(new OpenAICompatibleProvider(model()).streamResponse(messages));

    expect(chunks.at(-1)).toEqual({ type: "response_complete", streamed: true, finishReason: "stop" });
    expect(chunks.map((chunk) => chunk.type).lastIndexOf("usage")).toBeLessThan(chunks.length - 1);
  });

  it("rejects an OpenAI-compatible stream that ends without finish_reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}`,
    ));

    await expect(collect(new OpenAICompatibleProvider(model()).streamResponse(messages)))
      .rejects.toThrow("OpenAI-compatible stream ended without a finish_reason");
  });
});

describe("AnthropicProvider", () => {
  it("parses a final SSE event without a delimiter and preserves tool input", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3 } } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "lookup" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"status"}' } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } })}`,
      `\n\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ].join(""), true));

    const chunks = await collect(new AnthropicProvider(model({ provider: "anthropic" })).streamResponse(messages));
    const completedCall = chunks.find((chunk) => chunk.type === "tool_call_complete");
    const completed = chunks.find((chunk) => chunk.type === "response_complete");

    expect(chunks.filter((chunk) => chunk.type === "text_delta").map((chunk) => chunk.text).join("")).toBe("hello");
    expect(chunks.find((chunk) => chunk.type === "usage" && chunk.usage.input_tokens === 3)).toMatchObject({ usage: { input_tokens: 3 } });
    expect(completed).toMatchObject({ type: "response_complete", finishReason: "tool_use" });
    expect(completedCall).toMatchObject({ type: "tool_call_complete", toolCall: { id: "call_1", name: "lookup", argumentsJson: '{"query":"status"}' } });
  });

  it("rejects an Anthropic stream that ends without message_stop", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`,
    ].join("")));

    await expect(collect(new AnthropicProvider(model({ provider: "anthropic" })).streamResponse(messages)))
      .rejects.toThrow("anthropic stream ended without a message_stop event");
  });
});
