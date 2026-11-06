import { execFile } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  classifyModelRetry,
  EmptyModelResponseError,
  parseCompletedToolCall,
  workspaceSnapshot,
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

describe("workspaceSnapshot", () => {
  it("detects another edit to an already-dirty tracked file without changing its status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-snapshot-"));
    const file = join(workspace, "file with spaces.txt");
    const git = promisify(execFile);
    try {
      await git("git", ["init", "-q", workspace], { windowsHide: true });
      await writeFile(file, "original");
      await git("git", ["-C", workspace, "add", "file with spaces.txt"], { windowsHide: true });
      await writeFile(file, "first");
      await utimes(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
      const before = await workspaceSnapshot(workspace);

      await writeFile(file, "other");
      await utimes(file, new Date(2020, 0, 2), new Date(2020, 0, 2));
      const after = await workspaceSnapshot(workspace);

      expect(before.entries).toEqual(after.entries);
      expect(after.entries).toEqual(["AM file with spaces.txt"]);
      expect(after.fingerprint).not.toBe(before.fingerprint);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
