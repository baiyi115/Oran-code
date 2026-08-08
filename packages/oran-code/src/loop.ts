import type { LoopConfig, ToolCall } from "./types.js";

export interface NoProgressDiagnostic {
  call: ToolCall;
  repeatCount: number;
  limit: number;
}

export function toolCallSignature(call: ToolCall): string {
  return `${call.name}:${stableStringify(call.arguments)}`;
}

export class AgentLoop {
  readonly config: LoopConfig;
  steps = 0;
  turns = 0;
  tokensUsed = 0;
  consecutiveUnknownTools = 0;
  readonly toolCalls: ToolCall[];

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
  }

  record(call: ToolCall): void {
    if (!this.canRecordToolCall()) throw new Error("tool call budget exhausted");
    this.steps += 1;
    this.toolCalls.push(call);
    this.consecutiveUnknownTools = 0;
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
    const diagnostic = this.currentNoProgressRun();
    if (!diagnostic || diagnostic.limit <= 1) return undefined;
    const warningAt = Math.max(2, diagnostic.limit - 1);
    return diagnostic.repeatCount >= warningAt && diagnostic.repeatCount < diagnostic.limit
      ? diagnostic
      : undefined;
  }

  noProgressDiagnostic(): NoProgressDiagnostic | undefined {
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
      if (repeatCount >= limit) return { call, repeatCount, limit };
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
    return { call: last, repeatCount, limit };
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
