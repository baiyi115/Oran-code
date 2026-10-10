import { describe, expect, it } from "vitest";
import {
  classifyModelRetry,
  EmptyModelResponseError,
  parseCompletedToolCall,
  ToolCallParseError,
} from "../src/controller-utils.js";
import { ModelRequestError, SseIdleTimeoutError } from "../src/provider.js";

describe("classifyModelRetry", () => {
  it("classifies provider status codes by retry semantics", () => {
    expect(classifyModelRetry(new ModelRequestError(429, "slow down", 1000))).toBe("rate_limit");
    expect(classifyModelRetry(new ModelRequestError(408, "request timeout"))).toBe("timeout");
    expect(classifyModelRetry(new ModelRequestError(503, "unavailable"))).toBe("http_5xx");
    expect(classifyModelRetry(new ModelRequestError(400, "bad request"))).toBe("http_4xx");
  });

  it("classifies stream, empty and parse failures", () => {
    expect(classifyModelRetry(new SseIdleTimeoutError(60_000))).toBe("timeout");
    expect(classifyModelRetry(new EmptyModelResponseError())).toBe("empty");
    expect(classifyModelRetry(new ToolCallParseError("invalid arguments"))).toBe("parse");
  });

  it("classifies contract violations by error name without a reverse import", () => {
    const contractError = new Error("provider emitted text_delta after response_complete");
    contractError.name = "ProviderContractError";
    expect(classifyModelRetry(contractError)).toBe("contract");
  });

  it("classifies network failures by message and unknown errors as unknown", () => {
    expect(classifyModelRetry(new Error("fetch failed"))).toBe("network");
    expect(classifyModelRetry(new Error("something else"))).toBe("unknown");
  });
});

describe("parseCompletedToolCall", () => {
  it("reports malformed arguments as a ToolCallParseError", () => {
    expect(() => parseCompletedToolCall({ index: 0, name: "read_file", argumentsJson: '{"path": "a.ts"' })).toThrow(
      ToolCallParseError,
    );
  });
});
