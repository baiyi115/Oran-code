import { createHash } from "node:crypto";
import type { LoopConfig, ToolCall, ToolResult } from "./types.js";
import { normalizeTokenUsage } from "./token-usage.js";

export type NoProgressReason = "repeated_execution" | "repeated_error" | "semantic_stall";
export type NoProgressStage = "warning" | "reflection" | "pause";

export interface NoProgressDiagnostic {
  call: ToolCall;
  repeatCount: number;
  limit: number;
  reason: NoProgressReason;
  stage: NoProgressStage;
  detail?: string;
}

export interface TurnProgressSummary {
  stalledTurns: number;
  hasMutation: boolean;
  hasNewToolResult: boolean;
  evidence: string[];
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b[0-9a-fA-F]{32,64}\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const TEMP_PATH_RE = /(?:\/tmp\/|[A-Za-z]:\\(?:Users\\[^\\]+\\AppData\\Local\\Temp|Windows\\Temp)\\|\btemp\/|\.tmp-)[^\s"']+/gi;

export function normalizeToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeToolArguments(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeToolArguments(v)]),
    );
  }
  if (typeof value === "number") {
    if ((value >= 1_500_000_000 && value <= 2_500_000_000) || (value >= 1_500_000_000_000 && value <= 2_500_000_000_000)) {
      return "<TIMESTAMP>";
    }
  }
  return value;
}

function normalizeString(text: string): string {
  return text
    .replace(UUID_RE, "<UUID>")
    .replace(HEX_RE, "<HASH>")
    .replace(ISO_DATE_RE, "<TIMESTAMP>")
    .replace(TEMP_PATH_RE, "<TMP_PATH>")
    .replace(/\s+/g, " ")
    .trim();
}

export function toolCallSignature(call: ToolCall): string {
  return `${call.name}:${stableStringify(normalizeToolArguments(call.arguments))}`;
}

/** Stable, compact representation of the meaningful part of a tool result. */
export function toolResultSignature(result: ToolResult): string {
  const content = result.error || result.output || "";
  const normalized = stableStringify({ ok: result.ok, content: normalizeString(content) });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function errorSignature(result: ToolResult | undefined): string | undefined {
  if (!result || (result.ok && !result.error)) return undefined;
  const raw = result.error || result.output || "";
  if (!raw.trim()) return undefined;
  const lines = raw.split(/\r?\n/).slice(0, 3).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const normalized = normalizeString(lines.join(" "))
    .replace(/(?::\d+:\d+|\bline\s+\d+\b)/gi, ":LINE")
    .replace(/(?::\d{4,5}\b|\bport\s+\d{4,5}\b)/gi, ":PORT");
  return normalized.slice(0, 256);
}

export class AgentLoop {
  readonly config: LoopConfig;
  steps = 0;
  turns = 0;
  tokensUsed = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  modelElapsedMs = 0;
  consecutiveUnknownTools = 0;
  readonly toolCalls: ToolCall[];
  readonly executionHistory: Array<{
    call: ToolCall;
    callSig: string;
    result: ToolResult;
    resultSig: string;
    errorSig?: string | undefined;
  }> = [];
  consecutiveStalledTurns = 0;

  private static readonly MAX_EXECUTION_HISTORY = 50;
  private static readonly MAX_RESULT_FINGERPRINTS = 200;
  private readonly seenResultFingerprints = new Set<string>();
  private readonly resultFingerprintOrder: string[] = [];
  private turnResultFingerprints: string[] = [];

  constructor(config: LoopConfig, seedCalls: readonly ToolCall[] = []) {
    this.config = config;
    this.toolCalls = [...seedCalls];
  }

  canContinue(): boolean {
    if (this.config.tokenBudget > 0 && this.tokensUsed >= this.config.tokenBudget) return false;
    if (this.config.maxSteps <= 0) return false;
    if (this.shouldStopForUnknownTools()) return false;
    return this.turns < this.config.maxSteps;
  }

  canRecordToolCall(): boolean {
    return this.config.maxSteps > 0 && this.turns < this.config.maxSteps;
  }

  isFinalTurn(): boolean {
    return this.config.maxSteps > 0 && this.turns >= this.config.maxSteps;
  }

  remainingTurns(): number {
    return Math.max(0, this.config.maxSteps - this.turns);
  }

  tokenBudgetReached(): boolean {
    return this.config.tokenBudget > 0 && this.tokensUsed >= this.config.tokenBudget;
  }

  recordTurn(): void {
    this.turns += 1;
    this.turnResultFingerprints = [];
  }

  recordUsage(usage: Record<string, number>): void {
    if (!Object.keys(usage).length) return;
    const normalized = normalizeTokenUsage(usage);
    this.tokensUsed += normalized.totalTokens;
    this.inputTokens += normalized.inputTokens;
    this.outputTokens += normalized.outputTokens;
    this.cacheReadTokens += normalized.cacheReadTokens;
    this.cacheWriteTokens += normalized.cacheWriteTokens;
  }

  recordModelElapsed(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs > 0) this.modelElapsedMs += durationMs;
  }

  record(call: ToolCall): void {
    if (!this.canRecordToolCall()) throw new Error("tool call budget exhausted");
    this.steps += 1;
    this.toolCalls.push(call);
    this.consecutiveUnknownTools = 0;
  }

  recordResult(call: ToolCall, result: ToolResult): void {
    const errorSig = errorSignature(result);
    const callSig = toolCallSignature(call);
    const resultSig = toolResultSignature(result);
    this.executionHistory.push({ call, callSig, result, resultSig, errorSig });
    this.turnResultFingerprints.push(resultSig);
    if (this.executionHistory.length > AgentLoop.MAX_EXECUTION_HISTORY) {
      this.executionHistory.splice(0, this.executionHistory.length - AgentLoop.MAX_EXECUTION_HISTORY);
    }
  }

  recordTurnProgress(activity: {
    hasMutation: boolean;
    externalEvidence?: { kind: string; value: unknown };
  }): TurnProgressSummary {
    const externalFingerprint = activity.externalEvidence
      ? progressValueSignature(activity.externalEvidence)
      : undefined;
    const fingerprints = externalFingerprint
      ? [...this.turnResultFingerprints, externalFingerprint]
      : this.turnResultFingerprints;
    const newFingerprints = fingerprints.filter((fingerprint) => !this.seenResultFingerprints.has(fingerprint));
    for (const fingerprint of fingerprints) this.rememberResultFingerprint(fingerprint);

    const evidence: string[] = [];
    if (activity.hasMutation) evidence.push("workspace_mutated");
    if (this.turnResultFingerprints.some((fingerprint) => newFingerprints.includes(fingerprint))) {
      evidence.push("new_tool_result");
    }
    if (externalFingerprint && newFingerprints.includes(externalFingerprint)) {
      evidence.push(activity.externalEvidence!.kind);
    }

    if (evidence.length > 0) this.consecutiveStalledTurns = 0;
    else this.consecutiveStalledTurns += 1;

    return {
      stalledTurns: this.consecutiveStalledTurns,
      hasMutation: activity.hasMutation,
      hasNewToolResult: newFingerprints.length > 0,
      evidence,
    };
  }

  recordUnknownTool(call: ToolCall): void {
    this.toolCalls.push(call);
    this.consecutiveUnknownTools += 1;
  }

  shouldStopForUnknownTools(): boolean {
    const limit = this.config.unknownToolLimit;
    return limit > 0 && this.consecutiveUnknownTools >= limit;
  }

  noProgressWarning(): NoProgressDiagnostic | undefined {
    const errorWarn = this.currentRepeatedErrorRun(2, "warning");
    if (errorWarn) return errorWarn;

    return this.currentSemanticStallAdvisory();
  }

  noProgressDiagnostic(): NoProgressDiagnostic | undefined {
    const errorDiag = this.currentRepeatedErrorRun(3, "pause");
    if (errorDiag) return errorDiag;

    return this.currentSemanticStallDiagnostic();
  }

  /**
   * Only block a non-readonly call before execution when its two most recent
   * executions had the same call and result. Readonly calls intentionally run
   * through: polling may return a new state even with identical arguments.
   */
  noProgressDiagnosticForNextCalls(calls: readonly ToolCall[]): NoProgressDiagnostic | undefined {
    if (!calls.length) return undefined;
    for (const call of calls) {
      const target = toolCallSignature(call);
      const last = this.executionHistory[this.executionHistory.length - 1];
      const previous = this.executionHistory[this.executionHistory.length - 2];
      if (!last || !previous) continue;
      if (last.callSig !== target || previous.callSig !== target || last.resultSig !== previous.resultSig) continue;
      return {
        call,
        repeatCount: 3,
        limit: 3,
        reason: "repeated_execution",
        stage: "pause",
        detail: last.resultSig,
      };
    }
    return undefined;
  }

  hasNoProgress(): boolean {
    return this.noProgressDiagnostic() !== undefined;
  }

  private currentRepeatedErrorRun(threshold: number, stage: NoProgressStage): NoProgressDiagnostic | undefined {
    const last = this.executionHistory[this.executionHistory.length - 1];
    if (!last || !last.errorSig) return undefined;
    const targetSig = last.errorSig;
    const targetCall = last.callSig;
    let count = 0;
    for (let i = this.executionHistory.length - 1; i >= 0; i -= 1) {
      const item = this.executionHistory[i];
      if (!item || item.callSig !== targetCall || item.errorSig !== targetSig) break;
      count += 1;
    }
    if (count >= threshold) {
      return {
        call: last.call,
        repeatCount: count,
        limit: 3,
        reason: "repeated_error",
        stage,
        detail: targetSig,
      };
    }
    return undefined;
  }

  private currentSemanticStallAdvisory(): NoProgressDiagnostic | undefined {
    const limit = this.config.noProgressLimit;
    if (limit <= 0 || this.consecutiveStalledTurns >= limit) return undefined;
    const warningAt = Math.min(3, Math.max(1, limit - 2));
    const reflectionAt = Math.min(5, Math.max(warningAt + 1, limit - 3));
    const stage: NoProgressStage | undefined = this.consecutiveStalledTurns >= reflectionAt
      ? "reflection"
      : this.consecutiveStalledTurns >= warningAt
        ? "warning"
        : undefined;
    if (!stage) return undefined;
    return this.semanticStallDiagnostic(stage);
  }

  private currentSemanticStallDiagnostic(): NoProgressDiagnostic | undefined {
    const limit = this.config.noProgressLimit;
    if (limit <= 0 || this.consecutiveStalledTurns < limit) return undefined;
    return this.semanticStallDiagnostic("pause");
  }

  private semanticStallDiagnostic(stage: NoProgressStage): NoProgressDiagnostic {
    const call = this.toolCalls[this.toolCalls.length - 1]
      ?? { name: "semantic_stall", arguments: {}, createdAt: new Date().toISOString() };
    return {
      call,
      repeatCount: this.consecutiveStalledTurns,
      limit: this.config.noProgressLimit,
      reason: "semantic_stall",
      stage,
      detail: `${this.consecutiveStalledTurns} consecutive turn(s) without new tool results or workspace changes`,
    };
  }

  private rememberResultFingerprint(fingerprint: string): void {
    if (this.seenResultFingerprints.has(fingerprint)) return;
    this.seenResultFingerprints.add(fingerprint);
    this.resultFingerprintOrder.push(fingerprint);
    if (this.resultFingerprintOrder.length <= AgentLoop.MAX_RESULT_FINGERPRINTS) return;
    const oldest = this.resultFingerprintOrder.shift();
    if (oldest) this.seenResultFingerprints.delete(oldest);
  }
}

function progressValueSignature(value: unknown): string {
  return createHash("sha256").update(stableStringify(normalizeToolArguments(value))).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}
