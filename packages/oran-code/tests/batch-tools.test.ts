import { describe, expect, it } from "vitest";
import {
  BATCH_TOOL_NAME,
  MAX_BATCH_STEPS,
  formatBatchScriptResult,
  parseBatchScript,
  registerBatchTools,
  substituteStepArguments,
} from "../src/tools/batch-tools.js";
import { ToolRegistry } from "../src/tools.js";
import type { BatchStepOutcome } from "../src/tools/batch-tools.js";

const validScript = {
  steps: [
    { id: "s1", tool: "read_file", arguments: { path: "pkg.json" } },
    { id: "s2", tool: "search_code", arguments: { pattern: "x", path: { $ref: "s1" } } },
  ],
};

describe("parseBatchScript", () => {
  it("accepts a valid script with backward references and defaults on_failure to abort", () => {
    const script = parseBatchScript(validScript);
    expect(script.onFailure).toBe("abort");
    expect(script.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
  });

  it("accepts explicit continue policy", () => {
    expect(parseBatchScript({ ...validScript, on_failure: "continue" }).onFailure).toBe("continue");
  });

  it("rejects non-object arguments and empty or oversized step lists", () => {
    expect(() => parseBatchScript(null)).toThrow("must be an object");
    expect(() => parseBatchScript({})).toThrow("non-empty array");
    expect(() =>
      parseBatchScript({
        steps: Array.from({ length: MAX_BATCH_STEPS + 1 }, (_, index) => ({ id: `s${index}`, tool: "t" })),
      }),
    ).toThrow("at most");
  });

  it("rejects duplicate ids, missing fields, and recursive batch_tools", () => {
    expect(() =>
      parseBatchScript({
        steps: [
          { id: "s1", tool: "a" },
          { id: "s1", tool: "b" },
        ],
      }),
    ).toThrow('duplicate step id "s1"');
    expect(() => parseBatchScript({ steps: [{ tool: "a" }] })).toThrow(".id");
    expect(() => parseBatchScript({ steps: [{ id: "s1" }] })).toThrow(".tool");
    expect(() => parseBatchScript({ steps: [{ id: "s1", tool: BATCH_TOOL_NAME }] })).toThrow("recursively");
  });

  it("rejects forward, self, and unknown references", () => {
    expect(() =>
      parseBatchScript({
        steps: [
          { id: "s1", tool: "a", arguments: { x: { $ref: "s2" } } },
          { id: "s2", tool: "b" },
        ],
      }),
    ).toThrow('references "s2"');
    expect(() => parseBatchScript({ steps: [{ id: "s1", tool: "a", arguments: { x: "${s1}" } }] })).toThrow(
      'references "s1"',
    );
    expect(() =>
      parseBatchScript({
        steps: [
          { id: "s1", tool: "a" },
          { id: "s2", tool: "b", arguments: { x: "${nope}" } },
        ],
      }),
    ).toThrow('references "nope"');
  });

  it("collects references from nested structures and interpolated strings", () => {
    const script = parseBatchScript({
      steps: [
        { id: "s1", tool: "a" },
        {
          id: "s2",
          tool: "b",
          arguments: {
            direct: { $ref: "s1" },
            nested: { list: [{ deep: { $ref: "s1.output" } }] },
            text: "prefix-${s1}-suffix",
          },
        },
      ],
    });
    expect(script.steps[1]!.arguments).toBeDefined();
  });
});

describe("substituteStepArguments", () => {
  const outputs = new Map<string, string>([
    ["json", '{"path":"src/a.ts","line":3}'],
    ["text", "plain output"],
  ]);

  it("replaces a whole-value ref with JSON-parsed output when parseable", () => {
    const resolved = substituteStepArguments({ target: { $ref: "json" } }, (id) => outputs.get(id));
    expect(resolved).toEqual({ target: { path: "src/a.ts", line: 3 } });
  });

  it("keeps a whole-value ref as a string when the output is not JSON", () => {
    const resolved = substituteStepArguments({ target: { $ref: "text" } }, (id) => outputs.get(id));
    expect(resolved).toEqual({ target: "plain output" });
  });

  it("interpolates refs inside strings and supports the .output suffix", () => {
    const resolved = substituteStepArguments({ a: "x-${text}-y", b: "${json.output}" }, (id) => outputs.get(id));
    expect(resolved).toEqual({ a: "x-plain output-y", b: '{"path":"src/a.ts","line":3}' });
  });

  it("keeps unresolvable placeholders verbatim instead of corrupting arguments", () => {
    const resolved = substituteStepArguments({ a: { $ref: "missing" }, b: "${missing}" }, () => undefined);
    expect(resolved).toEqual({ a: { $ref: "missing" }, b: "${missing}" });
  });

  it("leaves values without interpolation markers untouched", () => {
    const value = { a: "$ref", b: "{ $ref }" };
    expect(substituteStepArguments(value, () => "x")).toEqual(value);
  });
});

describe("formatBatchScriptResult", () => {
  const okStep: BatchStepOutcome = { id: "s1", tool: "read_file", ok: true, durationMs: 12, output: "content" };
  const failedStep: BatchStepOutcome = { id: "s2", tool: "edit_file", ok: false, error: "boom" };

  it("reports a fully successful script as ok with all step outputs", () => {
    const result = formatBatchScriptResult({ steps: [okStep], total: 1, onFailure: "abort", durationMs: 20 });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("batch_tools 1/1 steps, 0 failed");
    expect(result.output).toContain("=== step s1 [read_file] ok (12ms) ===");
    expect(result.output).toContain("content");
    expect(result.metadata).toMatchObject({ script: true, stepsTotal: 1, stepsExecuted: 1, stepsFailed: 0 });
  });

  it("marks failures and lists skipped steps after an abort", () => {
    const result = formatBatchScriptResult({
      steps: [okStep, failedStep],
      total: 4,
      onFailure: "abort",
      durationMs: 30,
      abortedAt: "s2",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('aborted at "s2" (on_failure=abort)');
    expect(result.output).toContain("Remaining 2 step(s) skipped.");
    expect(result.output).toContain("error: boom");
    expect(result.metadata).toMatchObject({ stepsFailed: 1, abortedAt: "s2" });
  });
});

describe("registerBatchTools", () => {
  it("registers batch_tools as a system command tool with a defensive invoke stub", async () => {
    const registry = new ToolRegistry();
    registerBatchTools(registry);
    const tool = registry.get(BATCH_TOOL_NAME);
    expect(tool.system).toBe(true);
    expect(tool.kind).toBe("command");
    const stub = await tool.invoke({ name: BATCH_TOOL_NAME, arguments: {}, createdAt: "" });
    expect(stub.ok).toBe(false);
    expect(stub.error).toContain("tool executor");
  });
});
