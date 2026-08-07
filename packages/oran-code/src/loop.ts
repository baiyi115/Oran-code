import type { LoopConfig, ToolCall } from "./types.js";

export class AgentLoop {
  readonly config: LoopConfig;
  steps = 0;
  turns = 0;
  tokensUsed = 0;
  consecutiveUnknownTools = 0;
  readonly toolCalls: ToolCall[] = [];

  constructor(config: LoopConfig) {
    this.config = config;
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

  hasNoProgress(): boolean {
    const limit = this.config.noProgressLimit;
    if (limit <= 0 || this.toolCalls.length < limit) return false;
    const recent = this.toolCalls.slice(-limit).map((call) => signature(call));
    for (let period = 1; period < recent.length; period += 1) {
      if (recent.every((value, index) => index < period || value === recent[index - period])) return true;
    }
    return new Set(recent).size === 1;
  }
}

function usageValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function signature(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments, Object.keys(call.arguments).sort())}`;
}
