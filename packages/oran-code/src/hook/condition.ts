import { matchesPattern } from "../security.js";
import {
  HOOK_EVENTS,
  type HookCondition,
  type HookConditionClause,
  type HookConditionLogic,
  type HookEvent,
  type HookEventContext,
  type HookOperator,
} from "./types.js";

const OPERATORS = new Set<HookOperator>(["==", "!=", "=~", "glob"]);

/** 把单行表达式解析为结构化条件。解析失败返回 undefined（调用方聚合为校验错误）。 */
export function parseCondition(expression: string): HookCondition | undefined {
  const trimmed = expression.trim();
  if (!trimmed) return undefined;

  // 先按 && 与 || 切分，记录分隔符，据此推断 logic 并禁止混用。
  const tokens = splitLogical(trimmed);
  if (!tokens) return undefined;

  const clauses = tokens.parts.map((part) => parseClause(part.trim())).filter((c): c is HookConditionClause => c !== undefined);
  if (clauses.length !== tokens.parts.length) return undefined; // 有子句解析失败
  if (clauses.length === 0) return undefined;

  return { logic: tokens.logic, clauses };
}

interface SplitResult {
  logic: HookConditionLogic;
  parts: string[];
}

/** 按顶层 && / || 切分；混合或嵌套非法。token 内不含括号，所以无需处理优先级。 */
function splitLogical(expression: string): SplitResult | undefined {
  // 用零宽切分保留分隔符
  const pieces = expression.split(/\s*(\&{2}|\|{2})\s*/);
  // pieces 形如 [part, sep, part, sep, part, ...]
  const parts: string[] = [];
  const seps: string[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (piece === undefined) continue;
    if (i % 2 === 0) {
      if (piece.trim()) parts.push(piece);
    } else if (piece === "&&" || piece === "||") {
      seps.push(piece);
    }
  }
  if (parts.length === 0) return undefined;
  if (seps.length === 0) {
  return { logic: "all", parts };
  }
  const first = seps[0];
  if (!first) return undefined;
  if (seps.some((s) => s !== first)) return undefined; // 混合 && || 非法
  return { logic: first === "&&" ? "all" : "any", parts };
}

/** 解析单条子句：field op value 或 !field op value。 */
function parseClause(text: string): HookConditionClause | undefined {
  if (!text) return undefined;
  let negate = false;
  let rest = text;
  if (rest.startsWith("!")) {
    negate = true;
    rest = rest.slice(1).trim();
  }
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=|=~|glob)\s*(.+)$/.exec(rest);
  if (!match) return undefined;
  const field = match[1];
  const operator = match[2] as HookOperator;
  const value = (match[3] ?? "").trim();
  if (!field || !OPERATORS.has(operator) || !value) return undefined;
  return { field, operator, negate, value };
}

/**
 * 在给定事件上下文下求值条件。
 * 返回 true 表示命中（触发动作）。
 *
 * 正则非法时静默视为不匹配。
 * 条件缺省（undefined）视为无条件命中。
 */
export function evaluateCondition(condition: HookCondition | undefined, ctx: HookEventContext): boolean {
  if (!condition) return true;
  if (condition.clauses.length === 0) return true;
  const results = condition.clauses.map((clause) => evaluateClause(clause, ctx));
  if (condition.logic === "all") return results.every(Boolean);
  return results.some(Boolean);
}

function evaluateClause(clause: HookConditionClause, ctx: HookEventContext): boolean {
  const left = fieldValue(clause.field, ctx);
  let matched: boolean;
  switch (clause.operator) {
    case "==":
      matched = left === clause.value;
      break;
    case "!=":
      matched = left !== clause.value;
      break;
    case "=~":
      try {
        matched = new RegExp(clause.value, "i").test(left);
      } catch {
        // 正则非法静默视为不匹配
        matched = false;
      }
      break;
    case "glob":
      matched = matchesPattern(clause.value, left);
      break;
    default:
      matched = false;
  }
  return clause.negate ? !matched : matched;
}

/** 从上下文取出字段的字符串值用于匹配。未知字段返回空串（视为不匹配）。 */
function fieldValue(field: string, ctx: HookEventContext): string {
  switch (field) {
    case "event":
      return ctx.event;
    case "tool":
      return ctx.tool?.name ?? "";
    case "path":
    case "file_path":
    case "filePath":
      return ctx.filePath ?? "";
    case "command":
      return typeof ctx.tool?.arguments.command === "string" ? ctx.tool.arguments.command : "";
    case "user":
    case "userPrompt":
      return ctx.userPrompt ?? "";
    case "assistant":
    case "assistantText":
      return ctx.assistantText ?? "";
    case "workspace":
      return ctx.workspace ?? "";
    case "model":
      return ctx.model ?? "";
    default:
  if (ctx.tool && field in ctx.tool.arguments) {
        const v = (ctx.tool.arguments as Record<string, unknown>)[field];
        return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
      }
      return "";
  }
}

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
}
