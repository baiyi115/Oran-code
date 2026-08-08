import { asyncErrorText, errorPrefix, executeAction } from "./actions.js";
import { evaluateCondition, parseCondition } from "./condition.js";
import {
  HOOK_ACTION_TYPES,
  HOOK_EVENTS,
  type HookConfig,
  type HookDispatchResult,
  type HookEngineDeps,
  type HookEventContext,
  type HookResult,
  type HookSubAgentExecutor,
  type HookValidationError,
} from "./types.js";

const VALID_EVENTS = new Set<string>(HOOK_EVENTS);
const VALID_ACTION_TYPES = new Set<string>(HOOK_ACTION_TYPES);

interface CompiledRule {
  config: HookConfig;
  condition: ReturnType<typeof parseCondition>;
  onceKey: string;
  intercept: boolean;
  async: boolean;
  onError: NonNullable<HookConfig["onError"]>;
}

export interface HookEngineOptions extends HookEngineDeps {
  defaultCommandTimeoutMs: number;
}

export class HookEngine {
  private readonly rules: CompiledRule[] = [];
  private readonly validationErrors: HookValidationError[] = [];
  private readonly onceFired = new Set<string>();
  private readonly deps: HookEngineDeps;
  private readonly defaultCommandTimeoutMs: number;

  constructor(configs: readonly HookConfig[], options: HookEngineOptions) {
    this.deps = options;
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs;
    for (let index = 0; index < configs.length; index += 1) {
      const config = configs[index];
      if (!config) continue;
      const compiled = this.compile(index, config);
      if (compiled) this.rules.push(compiled);
    }
  }

  getErrors(): readonly HookValidationError[] {
    return this.validationErrors;
  }

  get hasRules(): boolean {
    return this.rules.length > 0;
  }

  async dispatch(ctx: HookEventContext): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const rule of this.matchingRules(ctx)) {
      const result = await this.runRule(rule, ctx, rule.intercept);
      if (!result) continue;
      // Non-tool events do not consume interception; output still reaches the notice queue.
      this.collectOutput(rule, result, ctx);
      if (!rule.async) results.push(result);
    }
    return results;
  }

  async dispatchBeforeTool(ctx: HookEventContext): Promise<HookDispatchResult> {
    const results: HookResult[] = [];
    for (const rule of this.matchingRules(ctx)) {
      if (rule.async) {
        // Async rules never intercept; results flow back through the notice queue.
        void this.runAsync(rule, ctx, false);
        continue;
      }
      const result = await this.runRule(rule, ctx, rule.intercept);
      if (!result) continue;
      this.collectOutput(rule, result, ctx);
      results.push(result);
      if (result.intercept) {
        return { intercepted: true, interceptReason: result.output, results };
      }
    }
    return { intercepted: false, results };
  }

  drainNotices(): { event: string; text: string }[] {
    return this.deps.notices.drain();
  }

  setSessionMessages(fn: () => import("../types.js").Message[]): void {
    this.deps.sessionMessages = fn;
  }

  resetOnce(): void {
    this.onceFired.clear();
  }

  // ---- Internals ----

  private *matchingRules(ctx: HookEventContext): Iterable<CompiledRule> {
    for (const rule of this.rules) {
      if (rule.config.event !== ctx.event) continue;
      if (rule.config.once && this.onceFired.has(rule.onceKey)) continue;
      if (!evaluateCondition(rule.condition, ctx)) continue;
      if (rule.config.once) this.onceFired.add(rule.onceKey);
      yield rule;
    }
  }

  private async runRule(rule: CompiledRule, ctx: HookEventContext, intercept: boolean): Promise<HookResult | undefined> {
    if (rule.async) {
      void this.runAsync(rule, ctx, intercept);
      return { output: "", ok: true, intercept: false };
    }
    const result = await executeAction(rule.config.action, ctx, this.deps, this.defaultCommandTimeoutMs, intercept);
    return this.applyErrorPolicy(rule, result);
  }

  private async runAsync(rule: CompiledRule, ctx: HookEventContext, intercept: boolean): Promise<void> {
    try {
      const result = await executeAction(rule.config.action, ctx, this.deps, this.defaultCommandTimeoutMs, intercept);
      const applied = this.applyErrorPolicy(rule, result);
      if (!applied) return;
      if (applied.output) {
        this.deps.notices.append({ event: ctx.event, text: applied.output });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`async hook ${rule.onceKey} failed: ${message}`);
      this.deps.notices.append({ event: ctx.event, text: asyncErrorText(message) });
    }
  }

  private applyErrorPolicy(rule: CompiledRule, result: HookResult): HookResult | undefined {
    if (result.ok) return result;
    switch (rule.onError) {
      case "ignore":
        return undefined;
      case "fail":
        return { output: result.output || errorPrefix(`hook ${rule.onceKey} failed`), ok: false, intercept: false };
      case "reject":
        return { output: result.output || errorPrefix(`hook ${rule.onceKey} rejected`), ok: false, intercept: true };
      default:
        return result;
    }
  }

  private collectOutput(rule: CompiledRule, result: HookResult, ctx: HookEventContext): void {
    if (result.output && !rule.async) {
      this.deps.notices.append({ event: ctx.event, text: result.output });
    }
  }

  private log(message: string): void {
    try {
      this.deps.log?.(message);
    } catch { /* Logging failures are intentionally ignored. */ }
  }

  // ---- Validation ----

  private compile(index: number, config: HookConfig): CompiledRule | undefined {
    const errors: string[] = [];

    if (!config.event || !VALID_EVENTS.has(config.event)) {
      errors.push(`event must be one of ${HOOK_EVENTS.join(", ")}`);
    }
    const action = config.action;
    if (!action || !action.type || !VALID_ACTION_TYPES.has(action.type)) {
      errors.push(`action.type must be one of ${HOOK_ACTION_TYPES.join(", ")}`);
    } else {
      switch (action.type) {
        case "command":
          if (!action.command || !action.command.trim()) errors.push("command action requires a non-empty command");
          break;
        case "prompt":
          if (!action.prompt || !action.prompt.trim()) errors.push("prompt action requires a non-empty prompt");
          break;
        case "http":
          if (!action.url || !action.url.trim()) errors.push("http action requires a non-empty url");
          break;
        case "subagent":
          if ((!action.prompt || !action.prompt.trim()) && (!action.command || !action.command.trim())) {
            errors.push("subagent action requires a non-empty prompt or command");
          }
          break;
      }
    }

    if (config.intercept && config.async) {
      errors.push("intercept and async are mutually exclusive");
    }
    const intercept = config.intercept === true;
    const asyncFlag = config.async === true;
    const onError = config.onError ?? "ignore";

    let condition: ReturnType<typeof parseCondition> = undefined;
    if (config.if && config.if.trim()) {
      condition = parseCondition(config.if);
      if (!condition) errors.push(`cannot parse condition expression: ${config.if}`);
    }

    if (errors.length) {
      for (const message of errors) {
        const entry: HookValidationError = { index, message };
        if (config.id) entry.id = config.id;
        this.validationErrors.push(entry);
      }
      // A single bad rule must not block the remaining hooks.
      return undefined;
    }

    const onceKey = config.id?.trim() || `${config.event}:${config.action.type}`;
    return {
      config,
      condition,
      onceKey,
      intercept,
      async: asyncFlag,
      onError,
    };
  }
}

export type { HookSubAgentExecutor };
