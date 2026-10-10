import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import type { ToolCall, ToolResult } from "../types.js";
import { errorSignature, toolCallSignature, toolResultSignature } from "../loop.js";
import { workspaceFingerprint } from "../controller-utils.js";

/**
 * Per-turn capture: compress executed calls, workspace fingerprint, token
 * deltas, and external evidence into one TurnSnapshot. Records only; all
 * judgment happens elsewhere.
 */

export interface ProgressEvidence {
  testsPassed?: number | undefined;
  testsTotal?: number | undefined;
  typecheckOk?: boolean | undefined;
  buildOk?: boolean | undefined;
}

export interface CapturedToolCall {
  name: string;
  /** Normalized call signature (argument hash); reuses the loop's normalization. */
  argsDigest: string;
  resultDigest: string;
  ok: boolean;
  readonly: boolean;
  /** True only when the call really changed the workspace (a no-op write is false). */
  mutated: boolean;
  errorSig?: string | undefined;
  /** Declared target paths of write calls (workspace-relative, forward slashes). */
  paths: string[];
}

export interface TurnSnapshot {
  turn: number;
  ts: string;
  /** Workspace fingerprint (git status level); reused on turns without mutation. */
  workspaceDigest: string;
  toolCalls: CapturedToolCall[];
  tokensIn: number;
  tokensOut: number;
  cumulativeTokensIn: number;
  cumulativeTokensOut: number;
  evidence: ProgressEvidence | undefined;
}

export function goalFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

/** Declared target paths of a write call, workspace-relative with forward slashes. */
export function declaredWritePaths(call: ToolCall, workspace: string): string[] {
  const raw = call.arguments.path;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const absolute = resolve(workspace, raw);
  const rel = relative(workspace, absolute).replaceAll("\\", "/");
  return [rel || raw];
}

const TESTS_PASSED_PATTERNS: RegExp[] = [
  /Tests?:?\s+\d+\s+failed,\s+(\d+)\s+passed/i, // jest: Tests: 1 failed, 4 passed
  /\b(\d+)\s+failed\s*\|[^|]*\b(\d+)\s+passed/i, // vitest: 3 failed | 40 passed
  /(\d+)\s+failed,\s*(\d+)\s+passed/i, // pytest: 5 failed, 40 passed
  /\b(\d+)\s+passing/i, // mocha: 40 passing
  /\b(\d+)\s+passed/i, // generic fallback
];
const TESTS_TOTAL_PATTERN = /(\d+)\s+total\b/i;
const TYPECHECK_FAILURE_PATTERN = /\berror\s+TS\d+/i;
const TYPECHECK_COMMAND_PATTERN = /\b(tsc|vue-tsc|typecheck|tsgo)\b/i;
const BUILD_COMMAND_PATTERN = /\b(build|compile)\b/i;

/**
 * Extract verifiable external evidence from run_command output. When several
 * commands ran in one turn, the last non-empty value per field wins; returns
 * undefined when nothing recognizable appeared.
 */
export function extractEvidence(calls: ReadonlyArray<{ call: ToolCall; result: ToolResult }>): ProgressEvidence | undefined {
  const evidence: ProgressEvidence = {};
  for (const { call, result } of calls) {
    if (call.name !== "run_command") continue;
    const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
    const output = `${result.output ?? ""}\n${result.error ?? ""}`;

    if (TYPECHECK_COMMAND_PATTERN.test(command)) {
      evidence.typecheckOk = result.ok && !TYPECHECK_FAILURE_PATTERN.test(output);
      continue;
    }
    if (BUILD_COMMAND_PATTERN.test(command)) {
      evidence.buildOk = result.ok;
    }
    let passed: number | undefined;
    for (const pattern of TESTS_PASSED_PATTERNS) {
      const match = pattern.exec(output);
      if (!match) continue;
      // vitest/pytest forms carry the passed count in the second group;
      // jest/mocha forms only have one.
      passed = Number(match[2] ?? match[1]);
      break;
    }
    if (passed !== undefined && Number.isFinite(passed)) {
      evidence.testsPassed = passed;
      const totalMatch = TESTS_TOTAL_PATTERN.exec(output);
      if (totalMatch) {
        evidence.testsTotal = Number(totalMatch[1]);
      } else {
        // Summaries without a total: total = passed + failed.
        const failedMatch = /(\d+)\s+failed/i.exec(output);
        evidence.testsTotal = failedMatch ? passed + Number(failedMatch[1]) : passed;
      }
    }
  }
  return Object.keys(evidence).length ? evidence : undefined;
}

export interface CaptureTurnInput {
  turn: number;
  workspace: string;
  /** Calls actually executed this turn; skipped or blocked calls are not included. */
  executed: ReadonlyArray<{ call: ToolCall; result: ToolResult; mutated: boolean }>;
  isReadonly: (name: string) => boolean;
  cumulativeTokensIn: number;
  cumulativeTokensOut: number;
  previous?: TurnSnapshot | undefined;
}

export async function captureTurnSnapshot(input: CaptureTurnInput): Promise<TurnSnapshot> {
  const anyMutated = input.executed.some((item) => item.mutated);
  // The fingerprint describes the workspace's current state, so it cannot
  // change on a turn without mutation; reuse the previous value instead of
  // paying a git status call.
  const workspaceDigest =
    anyMutated || !input.previous
      ? await workspaceFingerprint(input.workspace)
      : input.previous.workspaceDigest;

  const toolCalls: CapturedToolCall[] = input.executed.map(({ call, result, mutated }) => ({
    name: call.name,
    argsDigest: toolCallSignature(call),
    resultDigest: toolResultSignature(result),
    ok: result.ok,
    readonly: input.isReadonly(call.name),
    mutated,
    errorSig: errorSignature(result),
    paths: input.isReadonly(call.name) ? [] : declaredWritePaths(call, input.workspace),
  }));

  const previousIn = input.previous?.cumulativeTokensIn ?? 0;
  const previousOut = input.previous?.cumulativeTokensOut ?? 0;
  return {
    turn: input.turn,
    ts: new Date().toISOString(),
    workspaceDigest,
    toolCalls,
    tokensIn: Math.max(0, input.cumulativeTokensIn - previousIn),
    tokensOut: Math.max(0, input.cumulativeTokensOut - previousOut),
    cumulativeTokensIn: input.cumulativeTokensIn,
    cumulativeTokensOut: input.cumulativeTokensOut,
    evidence: extractEvidence(input.executed),
  };
}
