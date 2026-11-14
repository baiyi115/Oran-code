import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseTestSummary } from "../evidence/parsers.js";
import type { EvidenceRecord } from "../evidence/types.js";
import type { ToolCall, ToolResult } from "../types.js";
import { errorSignature, toolCallSignature, toolResultSignature } from "../loop.js";

/**
 * Per-turn capture: compress executed calls, workspace fingerprint, token
 * deltas, and external evidence into one TurnSnapshot. Records only; all
 * judgment happens elsewhere.
 */

export interface ProgressEvidence {
  testsPassed?: number | undefined;
  testsTotal?: number | undefined;
  testsFailed?: number | undefined;
  typecheckOk?: boolean | undefined;
  buildOk?: boolean | undefined;
  /**
   * Signature of the command that produced the test counts. Counts from
   * different commands are not comparable: `vitest run tests/one.test.ts`
   * passes far fewer tests than a full run, and diffing the two numbers would
   * read as a regression instead of a narrower selection.
   */
  commandSig?: string | undefined;
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
  /**
   * Content digest of this task's tracked files (see trackedPaths). Identical
   * values mean the same bytes in the same files, which is what the state-loop
   * check compares. Empty until the task writes something.
   */
  workspaceDigest: string;
  /** Files this task has written so far (workspace-relative, sorted). */
  trackedPaths: string[];
  toolCalls: CapturedToolCall[];
  tokensIn: number;
  tokensOut: number;
  cumulativeTokensIn: number;
  cumulativeTokensOut: number;
  evidence: ProgressEvidence | undefined;
  evidenceRefs?: Array<{ taskId: string; attemptId: string; executionId: string }>;
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

const TYPECHECK_FAILURE_PATTERN = /\berror\s+TS\d+/i;
const TYPECHECK_COMMAND_PATTERN = /\b(tsc|vue-tsc|typecheck|tsgo)\b/i;
const BUILD_COMMAND_PATTERN = /\b(build|compile)\b/i;

/**
 * Extract legacy diagnostic summaries; this is not the acceptance ledger.
 * Per-field values remain intentionally lossy for existing progress consumers.
 */
export function extractEvidence(
  calls: ReadonlyArray<{ call: ToolCall; result: ToolResult }>,
): ProgressEvidence | undefined {
  const evidence: ProgressEvidence = {};
  for (const { call, result } of calls) {
    const receipt = result.metadata?.commandEvidence as EvidenceRecord | undefined;
    if (call.name !== "run_command" && !receipt) continue;
    const command = receipt?.command ?? (typeof call.arguments.command === "string" ? call.arguments.command : "");
    if (receipt?.executionStatus === "running" || (result.metadata?.backgroundJobId && !receipt?.finishedAt)) continue;
    const output = `${result.output ?? ""}\n${result.error ?? ""}`;
    const finished = receipt
      ? receipt.executionStatus === "completed" && receipt.exitCode === 0
      : result.ok && !result.metadata?.backgroundJobId && !result.metadata?.cancelled && !result.metadata?.timedOut;
    if (TYPECHECK_COMMAND_PATTERN.test(command))
      evidence.typecheckOk = finished && !TYPECHECK_FAILURE_PATTERN.test(output);
    if (BUILD_COMMAND_PATTERN.test(command)) evidence.buildOk = finished;
    const parsed = receipt ? { summary: receipt.summary } : parseTestSummary(output);
    const counts = parsed.summary;
    if (counts.passed !== undefined || counts.failed !== undefined || counts.total !== undefined) {
      evidence.testsPassed = counts.passed;
      evidence.testsFailed = counts.failed;
      evidence.commandSig = receipt?.commandSig ?? toolCallSignature(call);
      evidence.testsTotal =
        counts.total ??
        (counts.passed !== undefined && counts.failed !== undefined ? counts.passed + counts.failed : counts.passed);
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
  /** Files earlier turns of this task already wrote to. */
  previousTrackedPaths?: readonly string[] | undefined;
  previous?: TurnSnapshot | undefined;
}

/**
 * Digest of the tracked files' contents. Deliberately not the workspace
 * fingerprint: that one folds in sizes and mtimes, so it can never return to a
 * value an earlier turn produced, and the state-loop check — which looks for
 * exactly that repetition — could never fire.
 */
async function trackedContentDigest(workspace: string, paths: readonly string[]): Promise<string> {
  const digest = createHash("sha256");
  for (const path of paths) {
    const content = await readFile(resolve(workspace, path)).catch(() => undefined);
    const entry = content === undefined ? "<missing>" : createHash("sha256").update(content).digest("hex");
    digest.update(path).update("\0").update(entry).update("\n");
  }
  return digest.digest("hex").slice(0, 16);
}

export async function captureTurnSnapshot(input: CaptureTurnInput): Promise<TurnSnapshot> {
  const anyMutated = input.executed.some((item) => item.mutated);
  const turnPaths = input.executed
    .filter((item) => item.mutated && !input.isReadonly(item.call.name))
    .flatMap((item) => declaredWritePaths(item.call, input.workspace));
  const trackedPaths = [...new Set([...(input.previousTrackedPaths ?? []), ...turnPaths])].sort();
  // Only a mutating turn can have changed these files, so a read-only turn
  // reuses the previous digest instead of re-reading them.
  const workspaceDigest =
    trackedPaths.length === 0
      ? ""
      : anyMutated || input.previous?.trackedPaths === undefined
        ? await trackedContentDigest(input.workspace, trackedPaths)
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
    trackedPaths,
    toolCalls,
    tokensIn: Math.max(0, input.cumulativeTokensIn - previousIn),
    tokensOut: Math.max(0, input.cumulativeTokensOut - previousOut),
    cumulativeTokensIn: input.cumulativeTokensIn,
    cumulativeTokensOut: input.cumulativeTokensOut,
    evidence: extractEvidence(input.executed),
    evidenceRefs: input.executed.flatMap(({ result }) => {
      const record = result.metadata?.commandEvidence as EvidenceRecord | undefined;
      return record ? [{ taskId: record.taskId, attemptId: record.attemptId, executionId: record.executionId }] : [];
    }),
  };
}
