import { describe, expect, it } from "vitest";
import { AgentLoop, toolCallSignature, toolResultSignature } from "../src/loop.js";
import type { LoopConfig, ToolCall, ToolResult } from "../src/types.js";

const baseConfig: LoopConfig = {
  maxSteps: 20,
  maxRetries: 5,
  commandTimeout: 60_000,
  noProgressLimit: 8,
  tokenBudget: 1_000_000,
  unknownToolLimit: 3,
  readonlyConcurrency: 4,
};
function call(name = "edit_file", args: Record<string, unknown> = { path: "src/a.ts" }): ToolCall {
  return { name, arguments: args, createdAt: "2026-08-28T00:00:00.000Z" };
}
function result(output: string, ok = true): ToolResult {
  return ok ? { ok, output } : { ok, output: "", error: output };
}
function recordTurn(loop: AgentLoop, toolCall: ToolCall, toolResult: ToolResult, mutation = false): void {
  loop.recordTurn();
  loop.record(toolCall);
  loop.recordResult(toolCall, toolResult);
  loop.recordTurnProgress({ hasMutation: mutation });
}

describe("tool signatures", () => {
  it("is stable across key order and volatile values", () => {
    const left = call("run_command", { id: "123e4567-e89b-12d3-a456-426614174000", at: "2026-08-28T01:02:03.000Z", options: { cwd: "C:\\Users\\baiyi\\AppData\\Local\\Temp\\run-123", retries: 1 } });
    const right = call("run_command", { options: { retries: 1, cwd: "C:\\Users\\other\\AppData\\Local\\Temp\\run-999" }, at: "2025-01-01T10:20:30Z", id: "223e4567-e89b-12d3-a456-426614174111" });
    expect(toolCallSignature(left)).toBe(toolCallSignature(right));
  });

  it("changes for meaningful arguments and result content", () => {
    expect(toolCallSignature(call("read_file", { path: "a.ts" }))).not.toBe(toolCallSignature(call("read_file", { path: "b.ts" })));
    expect(toolResultSignature(result("done"))).not.toBe(toolResultSignature(result("failed")));
  });

  it("normalizes volatile timestamps in results", () => {
    expect(toolResultSignature(result("done at 2026-08-28T01:02:03Z"))).toBe(toolResultSignature(result("done at 2025-01-01T10:20:30Z")));
  });
});

describe("AgentLoop no-progress guards", () => {
  it("pauses a third identical non-readonly execution after two identical results", () => {
    const loop = new AgentLoop(baseConfig);
    const toolCall = call();
    recordTurn(loop, toolCall, result("unchanged"));
    recordTurn(loop, toolCall, result("unchanged"));
    expect(loop.noProgressDiagnosticForNextCalls([toolCall])).toMatchObject({ reason: "repeated_execution", stage: "pause", repeatCount: 3 });
  });

  it("does not preempt a repeated call when its result changed", () => {
    const loop = new AgentLoop(baseConfig);
    const toolCall = call();
    recordTurn(loop, toolCall, result("first"));
    recordTurn(loop, toolCall, result("second"));
    expect(loop.noProgressDiagnosticForNextCalls([toolCall])).toBeUndefined();
  });

  it("warns on the second identical error and pauses on the third", () => {
    const loop = new AgentLoop(baseConfig);
    const toolCall = call("run_command", { command: "pnpm test" });
    recordTurn(loop, toolCall, result("Error at src/a.ts:10:2", false));
    recordTurn(loop, toolCall, result("Error at src/a.ts:11:3", false));
    expect(loop.noProgressWarning()).toMatchObject({ reason: "repeated_error", stage: "warning", repeatCount: 2 });
    recordTurn(loop, toolCall, result("Error at src/a.ts:12:4", false));
    expect(loop.noProgressDiagnostic()).toMatchObject({ reason: "repeated_error", stage: "pause", repeatCount: 3 });
  });

  it("does not merge equal errors from different calls", () => {
    const loop = new AgentLoop(baseConfig);
    recordTurn(loop, call("read_file", { path: "a.ts" }), result("not found", false));
    recordTurn(loop, call("read_file", { path: "b.ts" }), result("not found", false));
    expect(loop.noProgressWarning()).toBeUndefined();
  });

  it("moves through warning, reflection and pause for semantic stalls", () => {
    const loop = new AgentLoop(baseConfig);
    const toolCall = call("read_file", { path: "a.ts" });
    const oldResult = result("same observation");
    recordTurn(loop, toolCall, oldResult);
    for (let i = 0; i < 3; i += 1) recordTurn(loop, toolCall, oldResult);
    expect(loop.noProgressWarning()).toMatchObject({ reason: "semantic_stall", stage: "warning", repeatCount: 3 });
    for (let i = 0; i < 2; i += 1) recordTurn(loop, toolCall, oldResult);
    expect(loop.noProgressWarning()).toMatchObject({ reason: "semantic_stall", stage: "reflection", repeatCount: 5 });
    for (let i = 0; i < 3; i += 1) recordTurn(loop, toolCall, oldResult);
    expect(loop.noProgressDiagnostic()).toMatchObject({ reason: "semantic_stall", stage: "pause", repeatCount: 8 });
  });

  it("resets stalls on mutation or changed external evidence", () => {
    const loop = new AgentLoop(baseConfig);
    const toolCall = call("read_file", { path: "a.ts" });
    recordTurn(loop, toolCall, result("same"));
    recordTurn(loop, toolCall, result("same"));
    expect(loop.consecutiveStalledTurns).toBe(1);
    loop.recordTurn();
    expect(loop.recordTurnProgress({ hasMutation: true }).stalledTurns).toBe(0);
    loop.recordTurn();
    loop.recordTurnProgress({ hasMutation: false, externalEvidence: { kind: "verification_changed", value: "pass" } });
    expect(loop.consecutiveStalledTurns).toBe(0);
  });

  it("disables semantic stall detection when limit is zero", () => {
    const loop = new AgentLoop({ ...baseConfig, noProgressLimit: 0 });
    for (let i = 0; i < 10; i += 1) {
      loop.recordTurn();
      loop.recordTurnProgress({ hasMutation: false });
    }
    expect(loop.noProgressWarning()).toBeUndefined();
    expect(loop.noProgressDiagnostic()).toBeUndefined();
  });
});
