import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTurnSnapshot, extractEvidence, goalFingerprint, type ProgressEvidence, type TurnSnapshot } from "../src/progress/capture.js";
import { DEFAULT_EXPLORE_BUDGET, INITIAL_PHASE_STATE, updatePhase, type PhaseState } from "../src/progress/phase.js";
import { computeSignals } from "../src/progress/signals.js";
import { INITIAL_NOVELTY_STATE, updateNovelty } from "../src/progress/novelty.js";
import { judgeConvergence, parseRehearsal, type RehearsalData } from "../src/progress/rehearsal.js";
import { isExplorationTask } from "../src/progress/phase.js";
import { EMPTY_PROGRESS_STATE, ProgressStateStore } from "../src/progress/store.js";
import type { ProgressSignal } from "../src/progress/signals.js";
import type { ToolCall, ToolResult } from "../src/types.js";

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `${name}-1`, name, arguments: args, createdAt: "2026-09-29T00:00:00.000Z" };
}

function result(output = "", ok = true): ToolResult {
  return ok ? { ok, output } : { ok, output, error: "boom" };
}

describe("progress capture", () => {
  it("extracts vitest/jest/pytest evidence from run_command output", () => {
    const vitest = extractEvidence([
      { call: call("run_command", { command: "npx vitest run" }), result: result("Tests  3 failed | 40 passed (43)") },
    ]);
    expect(vitest).toMatchObject({ testsPassed: 40, testsTotal: 43 });

    const jest = extractEvidence([
      { call: call("run_command", { command: "npx jest" }), result: result("Tests: 1 failed, 4 passed, 5 total") },
    ]);
    expect(jest).toMatchObject({ testsPassed: 4, testsTotal: 5 });

    const pytest = extractEvidence([
      { call: call("run_command", { command: "pytest -q" }), result: result("5 failed, 40 passed in 1.2s") },
    ]);
    expect(pytest).toMatchObject({ testsPassed: 40, testsTotal: 45 });
  });

  it("marks typecheck failures from tsc output", () => {
    const evidence = extractEvidence([
      { call: call("run_command", { command: "tsc -p tsconfig.json" }), result: result("src/a.ts(1,1): error TS2304: nope", false) },
    ]);
    expect(evidence).toMatchObject({ typecheckOk: false });
  });

  it("returns undefined when no evidence-bearing command ran", () => {
    expect(extractEvidence([{ call: call("read_file", { path: "a.ts" }), result: result("...") }])).toBeUndefined();
  });

  it("classifies readonly/mutated calls and reuses the digest on read-only turns", async () => {
    const previous = await captureTurnSnapshot({
      turn: 1,
      workspace: process.cwd(),
      executed: [{ call: call("read_file", { path: "package.json" }), result: result("{}"), mutated: false }],
      isReadonly: (name) => name === "read_file",
      cumulativeTokensIn: 100,
      cumulativeTokensOut: 10,
    });
    expect(previous.toolCalls[0]).toMatchObject({ readonly: true, mutated: false, ok: true });

    const next = await captureTurnSnapshot({
      turn: 2,
      workspace: process.cwd(),
      executed: [
        { call: call("edit_file", { path: "src/a.ts" }), result: result("done"), mutated: true },
        { call: call("edit_file", { path: "src/a.ts" }), result: result("done"), mutated: false },
      ],
      isReadonly: (name) => name === "read_file",
      cumulativeTokensIn: 160,
      cumulativeTokensOut: 14,
      previous,
    });
    expect(next.toolCalls[0]).toMatchObject({ readonly: false, mutated: true, paths: ["src/a.ts"] });
    expect(next.toolCalls[1]).toMatchObject({ mutated: false, paths: ["src/a.ts"] });
    expect(next.workspaceDigest).not.toBe("");
    expect(next.tokensIn).toBe(60);
    expect(next.tokensOut).toBe(4);
    expect(goalFingerprint("x")).toBe(goalFingerprint("x"));
  });
});

function readSnapshot(turn: number, files: number): TurnSnapshot {
  return {
    turn,
    ts: "2026-09-29T00:00:00.000Z",
    workspaceDigest: `digest-${turn}`,
    toolCalls: Array.from({ length: files }, (_, i) => ({
      name: "read_file",
      argsDigest: `args-${turn}-${i}`,
      resultDigest: `result-${turn}-${i}`,
      ok: true,
      readonly: true,
      mutated: false,
      paths: [],
    })),
    tokensIn: 0,
    tokensOut: 0,
    cumulativeTokensIn: 0,
    cumulativeTokensOut: 0,
    evidence: undefined,
  };
}

function mutatedSnapshot(turn: number): TurnSnapshot {
  return {
    ...readSnapshot(turn, 0),
    toolCalls: [
      { name: "edit_file", argsDigest: "a", resultDigest: "r", ok: true, readonly: false, mutated: true, paths: ["src/a.ts"] },
    ],
  };
}

describe("phase machine", () => {
  const budgets = { exploreBudget: DEFAULT_EXPLORE_BUDGET, implementBudget: 30 };

  it("switches to implement on the first real mutation", () => {
    const first = updatePhase(undefined, readSnapshot(1, 5), budgets);
    expect(first.state.phase).toBe("explore");
    expect(first.state.readonlyFilesRead).toBe(5);

    const second = updatePhase(first.state, mutatedSnapshot(2), budgets);
    expect(second.state.phase).toBe("implement");
  });

  it("does not pause a long legal exploration; it only notes the budget crossing", () => {
    let state = INITIAL_PHASE_STATE;
    const allSignals: ProgressSignal[] = [];
    for (let turn = 1; turn <= DEFAULT_EXPLORE_BUDGET + 2; turn += 1) {
      const result = updatePhase(state, readSnapshot(turn, 1), budgets);
      state = result.state;
      allSignals.push(...result.signals);
    }
    expect(state.phase).toBe("explore");
    expect(state.readonlyFilesRead).toBe(DEFAULT_EXPLORE_BUDGET + 2);
    // Fires exactly once, at the crossing.
    expect(allSignals).toHaveLength(1);
    expect(allSignals[0]).toMatchObject({ kind: "explore_budget", severity: "info" });
  });

  it("emits phase_egress after consecutive pure-read turns inside implement", () => {
    let state = updatePhase(undefined, mutatedSnapshot(1), budgets).state;
    expect(state.phase).toBe("implement");

    const read1 = updatePhase(state, readSnapshot(2, 1), budgets);
    expect(read1.state.phase).toBe("implement");
    expect(read1.signals).toHaveLength(0);

    const read2 = updatePhase(read1.state, readSnapshot(3, 1), budgets);
    expect(read2.state.phase).toBe("explore");
    expect(read2.state.egressCount).toBe(1);
    // First retreat is informational only (assertion: signal fires on the second).
    expect(read2.signals).toHaveLength(1);
    expect(read2.signals[0]).toMatchObject({ kind: "phase_egress", severity: "info" });

    // A retreat after mutation re-enters implement normally.
    const again = updatePhase(read2.state, mutatedSnapshot(4), budgets);
    expect(again.state.phase).toBe("implement");

    // Second retreat escalates to warn.
    const read3 = updatePhase(again.state, readSnapshot(5, 1), budgets);
    const read4 = updatePhase(read3.state, readSnapshot(6, 1), budgets);
    expect(read4.state.egressCount).toBe(2);
    expect(read4.signals).toContainEqual(expect.objectContaining({ kind: "phase_egress", severity: "warn" }));
  });
});

function evidenceSnapshot(turn: number, evidence: ProgressEvidence | undefined, digest = `digest-${turn}`): TurnSnapshot {
  return { ...readSnapshot(turn, 0), workspaceDigest: digest, evidence };
}

function writeSnapshot(turn: number, paths: string[]): TurnSnapshot {
  return {
    ...readSnapshot(turn, 0),
    toolCalls: paths.map((path, i) => ({
      name: "edit_file",
      argsDigest: `a-${turn}-${i}`,
      resultDigest: `r-${turn}-${i}`,
      ok: true,
      readonly: false,
      mutated: true,
      paths: [path],
    })),
  };
}

describe("computeSignals", () => {
  const budgets = { exploreBudget: DEFAULT_EXPLORE_BUDGET, implementBudget: 30 };

  it("fires test_regression when testsPassed drops", () => {
    const signals = computeSignals({
      snapshots: [
        evidenceSnapshot(1, { testsPassed: 15, testsTotal: 20 }),
        evidenceSnapshot(2, { testsPassed: 12, testsTotal: 20 }),
      ],
      phase: INITIAL_PHASE_STATE,
      allowedPaths: [],
      budgets,
    });
    expect(signals).toContainEqual(expect.objectContaining({ kind: "test_regression", severity: "hard" }));
  });

  it("fires test_count_drop when the total test count shrinks", () => {
    const signals = computeSignals({
      snapshots: [
        evidenceSnapshot(1, { testsPassed: 20, testsTotal: 20 }),
        evidenceSnapshot(2, { testsPassed: 18, testsTotal: 18 }),
      ],
      phase: INITIAL_PHASE_STATE,
      allowedPaths: [],
      budgets,
    });
    expect(signals).toContainEqual(expect.objectContaining({ kind: "test_count_drop", severity: "hard" }));
  });

  it("fires implement_budget as hard once the implement turns exceed the budget", () => {
    const phase: PhaseState = { ...INITIAL_PHASE_STATE, phase: "implement", implementTurns: 31 };
    const signals = computeSignals({
      snapshots: [evidenceSnapshot(31, undefined)],
      phase,
      allowedPaths: [],
      budgets,
    });
    expect(signals).toContainEqual(expect.objectContaining({ kind: "implement_budget", severity: "hard" }));
  });

  it("fires state_loop when the workspace content returns to an earlier state", () => {
    const between = writeSnapshot(2, ["src/a.ts"]);
    const signals = computeSignals({
      snapshots: [evidenceSnapshot(1, undefined, "same"), between, evidenceSnapshot(3, undefined, "same")],
      phase: INITIAL_PHASE_STATE,
      allowedPaths: [],
      budgets,
    });
    expect(signals).toContainEqual(expect.objectContaining({ kind: "state_loop", severity: "warn" }));
  });

  it("warns on two consecutive out-of-scope turns and hard-pauses at four", () => {
    const base = { phase: INITIAL_PHASE_STATE, allowedPaths: ["src/a.ts"], budgets };
    const warn = computeSignals({
      snapshots: [writeSnapshot(1, ["src/b.ts"]), writeSnapshot(2, ["src/b.ts"])],
      ...base,
    });
    expect(warn).toContainEqual(expect.objectContaining({ kind: "goal_drift", severity: "warn" }));

    const hard = computeSignals({
      snapshots: [writeSnapshot(1, ["src/b.ts"]), writeSnapshot(2, ["src/b.ts"]), writeSnapshot(3, ["src/b.ts"]), writeSnapshot(4, ["src/b.ts"])],
      ...base,
    });
    expect(hard).toContainEqual(expect.objectContaining({ kind: "goal_drift", severity: "hard" }));

    // In-scope writes never drift, no matter how many turns.
    const none = computeSignals({
      snapshots: [writeSnapshot(1, ["src/a.ts"]), writeSnapshot(2, ["src/a.ts"]), writeSnapshot(3, ["src/a.ts"])],
      ...base,
    });
    expect(none).toHaveLength(0);
  });
});

describe("symbol novelty (mechanism B1)", () => {
  it("fires low_symbol_novelty after five consecutive turns of reading nothing new", () => {
    let state = INITIAL_NOVELTY_STATE;
    let signal = undefined;
    // Turn one legitimately learns the symbol; the next five add nothing.
    for (let turn = 0; turn < 6; turn += 1) {
      const result = updateNovelty(state, [{ file: `f${turn}.ts`, text: "export function helper() {}" }]);
      state = result.state;
      signal = result.signal;
    }
    expect(state.lowRun).toBe(5);
    expect(signal).toMatchObject({ kind: "low_symbol_novelty", severity: "warn" });
  });

  it("does not fire while every turn keeps introducing new symbols", () => {
    let state = INITIAL_NOVELTY_STATE;
    let signal = undefined;
    for (let turn = 0; turn < 8; turn += 1) {
      const result = updateNovelty(state, [{ file: `f${turn}.ts`, text: `export function fresh${turn}() {}` }]);
      state = result.state;
      signal = result.signal;
    }
    expect(signal).toBeUndefined();
  });

  it("prefers graph symbols and records the source", () => {
    const result = updateNovelty(INITIAL_NOVELTY_STATE, [
      { file: "a.ts", graphSymbols: ["alpha", "beta"], text: "class IgnoreRegex {}" },
    ]);
    expect(result.state.source).toBe("graph");
    // Regex text is ignored when graph symbols exist.
    expect(result.state.known).toEqual(["alpha", "beta"]);
  });
});

describe("structured rehearsal (mechanism B2)", () => {
  const baseline: RehearsalData = {
    hypothesis: "auth token",
    excluded: ["user.ts"],
    candidateSet: ["auth/token.ts", "auth/middleware.ts"],
    nextCheck: "read token.ts",
  };

  it("accepts a shrinking candidate set as converged", () => {
    const next: RehearsalData = { ...baseline, candidateSet: ["auth/token.ts"] };
    expect(judgeConvergence(baseline, next)).toBe("converged");
  });

  it("accepts a strictly growing exclusion list as converged", () => {
    const next: RehearsalData = { ...baseline, excluded: ["user.ts", "session.ts"] };
    expect(judgeConvergence(baseline, next)).toBe("converged");
  });

  it("judges a same-sized candidate swap as diverged, even with new content", () => {
    const next: RehearsalData = { ...baseline, candidateSet: ["auth/refresh.ts", "auth/store.ts"] };
    expect(judgeConvergence(baseline, next)).toBe("diverged");
  });

  it("treats an unparseable reply as no rehearsal at all (divergence)", () => {
    expect(parseRehearsal("I think the problem is somewhere in auth.")).toBeUndefined();
  });

  it("parses a fenced JSON rehearsal", () => {
    const reply = 'Here is my status:\n```json\n{"hypothesis":"h","excluded":["a"],"candidateSet":["b"],"nextCheck":"c"}\n```';
    expect(parseRehearsal(reply)).toMatchObject({ hypothesis: "h", candidateSet: ["b"] });
  });
});

describe("exploration declaration", () => {
  it("recognizes explicit exploration wording", () => {
    expect(isExplorationTask("调研这个模块的架构")).toBe(true);
    expect(isExplorationTask("Research why the build fails")).toBe(true);
    expect(isExplorationTask("Fix the bug in auth/login.ts")).toBe(false);
  });
});

describe("ProgressStateStore", () => {
  it("round-trips state and self-heals from corruption and deletion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oran-progress-"));
    try {
      const path = join(dir, ".oran", "progress", "state.json");
      const state = { ...EMPTY_PROGRESS_STATE, goalFingerprint: "fp-1", allowedPaths: ["src/a.ts"] };
      await new ProgressStateStore(dir).save(state);
      expect(await new ProgressStateStore(dir).load()).toMatchObject({
        goalFingerprint: "fp-1",
        allowedPaths: ["src/a.ts"],
      });

      // Deleted file: heals to the empty state without erroring.
      await rm(path);
      expect(await new ProgressStateStore(dir).load()).toMatchObject(EMPTY_PROGRESS_STATE);

      // Corrupt file: heals the same way.
      const { writeFile } = await import("node:fs/promises");
      await new ProgressStateStore(dir).save(state);
      await writeFile(path, "{ not json", "utf8");
      expect(await new ProgressStateStore(dir).load()).toMatchObject(EMPTY_PROGRESS_STATE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
