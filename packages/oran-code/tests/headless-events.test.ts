import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlEventLog } from "../src/headless-events.js";
import type { RuntimeEvent } from "../src/types.js";

function readRecords(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("JsonlEventLog token totals", () => {
  it("adds delegated subagent usage to the run's final totals", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-headless-events-"));
    try {
      const path = join(workspace, "events.jsonl");
      const log = JsonlEventLog.open(path, {
        model: "test/model",
        workspace,
        prompt: "do work",
        productVersion: "0.0.0",
      });
      const timestamp = new Date().toISOString();
      const completed: RuntimeEvent = {
        version: 1,
        type: "completed",
        taskId: "task-1",
        sequence: 1,
        timestamp,
        steps: 1,
        tokensUsed: 1_000,
        inputTokens: 900,
        outputTokens: 100,
        cacheReadTokens: 700,
        cacheWriteTokens: 0,
        elapsedMs: 10,
        modelElapsedMs: 5,
      };
      const subagent: RuntimeEvent = {
        version: 1,
        type: "subagent_usage",
        taskId: "subagent-1",
        sequence: 2,
        timestamp,
        name: "explore",
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
      };
      log.record(completed);
      log.record(subagent);

      await log.finish({ outcome: "completed", exitCode: 0, durationMs: 100, finalText: "done" });

      const records = readRecords(await readFile(path, "utf8"));
      const subagentRecord = records.find(
        (record) => record.kind === "runtime_event" && record.type === "subagent_usage",
      );
      expect(subagentRecord).toMatchObject({
        name: "explore",
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 400,
      });
      expect(records.find((record) => record.kind === "run_end")?.tokens).toEqual({
        input: 1_400,
        output: 150,
        cacheRead: 1_100,
        cacheWrite: 0,
        total: 1_550,
      });
      expect(records.find((record) => record.kind === "run_end")?.mainTokens).toEqual({
        input: 900,
        output: 100,
        cacheRead: 700,
        cacheWrite: 0,
        total: 1_000,
      });
      expect(records.find((record) => record.kind === "run_end")?.subagentTokens).toEqual({
        input: 500,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
        total: 550,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
