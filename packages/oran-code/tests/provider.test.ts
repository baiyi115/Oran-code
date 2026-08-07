import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/provider.js";
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
});
