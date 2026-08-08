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

/** 校验后的单条规则缓存（避免每次派发重解析条件）。 */
interface CompiledRule {
  config: HookConfig;
  condition: ReturnType<typeof parseCondition>;
  /** 缺省 id 时用于 once 去重的键。 */
  onceKey: string;
  /** 运行时拦截语义，校验层已排除拦截与异步互斥。 */
  intercept: boolean;
  async: boolean;
  onError: NonNullable<HookConfig["onError"]>;
}

export interface HookEngineOptions extends HookEngineDeps {
  /** 命令动作的默认超时（继承自 loop.commandTimeout）。 */
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

  /** 聚合校验错误，供会话挂载时一次性呈现。 */
  getErrors(): readonly HookValidationError[] {
    return this.validationErrors;
  }

  /** 是否有任何已加载的合法规则。 */
  get hasRules(): boolean {
    return this.rules.length > 0;
  }

  /**
   * 通用事件派发（非 before_tool_call）。
   * 同步执行命中规则，输出入通知队列；异步规则后台执行后回流队列。
   * 返回结果列表供调用方观察（主流程一般不消费）。
   */
  async dispatch(ctx: HookEventContext): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const rule of this.matchingRules(ctx)) {
      const result = await this.runRule(rule, ctx, rule.intercept);
      if (!result) continue;
      // 非工具前事件不消费拦截信号；但其输出仍按非空写入通知队列。
      this.collectOutput(rule, result, ctx);
      if (!rule.async) results.push(result);
    }
    return results;
  }

  /**
   * 工具调用前专用派发。
   * 命中拦截即中断后续 Hook；异步规则视为放行。
   */
  async dispatchBeforeTool(ctx: HookEventContext): Promise<HookDispatchResult> {
    const results: HookResult[] = [];
    for (const rule of this.matchingRules(ctx)) {
      if (rule.async) {
        // 异步视为放行，不参与拦截；后台执行后输出回流队列。
        void this.runAsync(rule, ctx, false);
        continue;
      }
      const result = await this.runRule(rule, ctx, rule.intercept);
      if (!result) continue;
      this.collectOutput(rule, result, ctx);
      results.push(result);
      // 拦截规则命中即阻止工具执行；无论动作成功与否都返回拒绝。
      if (result.intercept) {
        return { intercepted: true, interceptReason: result.output, results };
      }
    }
    return { intercepted: false, results };
  }

  /** 通知队列取出全部，主循环每轮顶部调用。 */
  drainNotices(): { event: string; text: string }[] {
    return this.deps.notices.drain();
  }

  /** 注入实时会话消息回调（HTTP 请求体序列化用）。 */
  setSessionMessages(fn: () => import("../types.js").Message[]): void {
    this.deps.sessionMessages = fn;
  }

  /** 重置 once 集合（重新挂载会话时清空）。 */
  resetOnce(): void {
    this.onceFired.clear();
  }

  // ---- 内部 ----

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

  /** 依据错误策略决定结果是否进入列表 / 拦截。返回 undefined 表示不进入结果列表。 */
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

  /** 同步路径下非空输出主动写入通知队列。 */
  private collectOutput(rule: CompiledRule, result: HookResult, ctx: HookEventContext): void {
    if (result.output && !rule.async) {
      this.deps.notices.append({ event: ctx.event, text: result.output });
    }
  }

  private log(message: string): void {
    try {
      this.deps.log?.(message);
    } catch { /* 日志失败忽略 */ }
  }

  // ---- 校验 ----

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
    // 拦截仅在 before_tool_call 有意义；其它事件下仅副作用。这里不强制配置，
    // 但记录一条警告级错误以便用户感知。
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
      return undefined; // 单条出错不阻塞其它 Hook
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
