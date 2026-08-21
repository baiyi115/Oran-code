import type { LoopConfig, ToolCall, ToolResult } from "./types.js";

export type NoProgressReason = "identical_call" | "repeated_error" | "readonly_stall";

export interface NoProgressDiagnostic {
  call: ToolCall;
  repeatCount: number;
  limit: number;
  reason: NoProgressReason;
  detail?: string;
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
  consecutiveUnknownTools = 0;
  readonly toolCalls: ToolCall[];
  readonly executionHistory: Array<{ call: ToolCall; result: ToolResult; errorSig?: string | undefined }> = [];
  consecutiveReadonlyTurns = 0;

  private static readonly MAX_EXECUTION_HISTORY = 50;

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
  }

  recordUsage(usage: Record<string, number>): void {
    if (!Object.keys(usage).length) return;
    const total = usageValue(usage.total_tokens)
      ?? usageValue(usage.prompt_tokens ?? usage.input_tokens) ?? 0;
    const output = usageValue(usage.completion_tokens ?? usage.output_tokens) ?? 0;
    const counted = usageValue(usage.total_tokens) ?? total + output;
    if (counted <= 0) return;
    this.tokensUsed += counted;
    this.inputTokens += total;
    this.outputTokens += output;
  }

  record(call: ToolCall): void {
    if (!this.canRecordToolCall()) throw new Error("tool call budget exhausted");
    this.steps += 1;
    this.toolCalls.push(call);
    this.consecutiveUnknownTools = 0;
  }

  recordResult(call: ToolCall, result: ToolResult): void {
    const errorSig = errorSignature(result);
    this.executionHistory.push({ call, result, errorSig });
    if (this.executionHistory.length > AgentLoop.MAX_EXECUTION_HISTORY) {
      this.executionHistory.splice(0, this.executionHistory.length - AgentLoop.MAX_EXECUTION_HISTORY);
    }
  }

  recordTurnActivity(activity: { hasMutation: boolean; isReadonly: boolean }): void {
    if (activity.hasMutation) {
      this.consecutiveReadonlyTurns = 0;
    } else if (activity.isReadonly) {
      this.consecutiveReadonlyTurns += 1;
    } else {
      this.consecutiveReadonlyTurns = 0;
    }
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
    const errorWarn = this.currentRepeatedErrorRun(2);
    if (errorWarn) return errorWarn;

    const stallWarn = this.currentReadonlyStallWarning();
    if (stallWarn) return stallWarn;

    const diagnostic = this.currentNoProgressRun();
    if (!diagnostic || diagnostic.limit <= 1) return undefined;
    const warningAt = Math.max(2, diagnostic.limit - 1);
    return diagnostic.repeatCount >= warningAt && diagnostic.repeatCount < diagnostic.limit
      ? diagnostic
      : undefined;
  }

  noProgressDiagnostic(): NoProgressDiagnostic | undefined {
    const errorDiag = this.currentRepeatedErrorRun(3);
    if (errorDiag) return errorDiag;

    const stallDiag = this.currentReadonlyStallDiagnostic();
    if (stallDiag) return stallDiag;

    const diagnostic = this.currentNoProgressRun();
    return diagnostic && diagnostic.repeatCount >= diagnostic.limit ? diagnostic : undefined;
  }

  /** 检查下一批工具调用是否已达重复上限（尚未执行时判断）。 */
  noProgressDiagnosticForNextCalls(calls: readonly ToolCall[]): NoProgressDiagnostic | undefined {
    const limit = this.config.noProgressLimit;
    if (limit <= 0 || !calls.length) return undefined;
    const priorCalls: ToolCall[] = [];
    for (const call of calls) {
      const target = toolCallSignature(call);
      let repeatCount = 0;
      for (let index = this.toolCalls.length - 1; index >= 0; index -= 1) {
        const previous = this.toolCalls[index];
        if (!previous || toolCallSignature(previous) !== target) break;
        repeatCount += 1;
      }
      for (let index = priorCalls.length - 1; index >= 0; index -= 1) {
        const previous = priorCalls[index];
        if (!previous || toolCallSignature(previous) !== target) break;
        repeatCount += 1;
      }
      repeatCount += 1;
      if (repeatCount >= limit) return { call, repeatCount, limit, reason: "identical_call" };
      priorCalls.push(call);
    }
    return undefined;
  }

  hasNoProgress(): boolean {
    return this.noProgressDiagnostic() !== undefined;
  }

  private currentNoProgressRun(): NoProgressDiagnostic | undefined {
    const limit = this.config.noProgressLimit;
    const last = this.toolCalls[this.toolCalls.length - 1];
    if (limit <= 0 || !last) return undefined;
    const target = toolCallSignature(last);
    let repeatCount = 0;
    for (let index = this.toolCalls.length - 1; index >= 0; index -= 1) {
      const call = this.toolCalls[index];
      if (!call || toolCallSignature(call) !== target) break;
      repeatCount += 1;
    }
    return { call: last, repeatCount, limit, reason: "identical_call" };
  }

  private currentRepeatedErrorRun(threshold: number): NoProgressDiagnostic | undefined {
    const last = this.executionHistory[this.executionHistory.length - 1];
    if (!last || !last.errorSig) return undefined;
    const targetSig = last.errorSig;
    let count = 0;
    for (let i = this.executionHistory.length - 1; i >= 0; i -= 1) {
      const item = this.executionHistory[i];
      if (!item || item.errorSig !== targetSig) break;
      count += 1;
    }
    if (count >= threshold) {
      return {
        call: last.call,
        repeatCount: count,
        limit: 3,
        reason: "repeated_error",
        detail: targetSig,
      };
    }
    return undefined;
  }

  private currentReadonlyStallWarning(): NoProgressDiagnostic | undefined {
    if (this.consecutiveReadonlyTurns >= 5 && this.consecutiveReadonlyTurns < 8) {
      const last = this.toolCalls[this.toolCalls.length - 1] ?? { name: "readonly_stall", arguments: {}, createdAt: new Date().toISOString() };
      return {
        call: last,
        repeatCount: this.consecutiveReadonlyTurns,
        limit: 8,
        reason: "readonly_stall",
        detail: `${this.consecutiveReadonlyTurns} consecutive read-only exploration turns without workspace changes`,
      };
    }
    return undefined;
  }

  private currentReadonlyStallDiagnostic(): NoProgressDiagnostic | undefined {
    if (this.consecutiveReadonlyTurns >= 8) {
      const last = this.toolCalls[this.toolCalls.length - 1] ?? { name: "readonly_stall", arguments: {}, createdAt: new Date().toISOString() };
      return {
        call: last,
        repeatCount: this.consecutiveReadonlyTurns,
        limit: 8,
        reason: "readonly_stall",
        detail: `${this.consecutiveReadonlyTurns} consecutive read-only exploration turns without workspace changes`,
      };
    }
    return undefined;
  }
}

function usageValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
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
