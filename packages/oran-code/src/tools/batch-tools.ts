import type { ToolDefinition, ToolResult } from "../types.js";
import { isRecord } from "../types.js";
import { redactSecretText } from "../formatting.js";

export const BATCH_TOOL_NAME = "batch_tools";
/** 单个脚本允许的最大步骤数:步骤间没有轮次推进,必须用硬上限防止无界执行。 */
export const MAX_BATCH_STEPS = 32;

const REF_KEY = "$ref";
const REF_OUTPUT_SUFFIX = ".output";
const INTERPOLATION_RE = /\$\{([^}]+)\}/g;

export interface BatchStepSpec {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface BatchScriptSpec {
  steps: BatchStepSpec[];
  onFailure: "abort" | "continue";
}

export interface BatchStepOutcome {
  id: string;
  tool: string;
  ok: boolean;
  durationMs?: number;
  summary?: string;
  output?: string;
  error?: string;
}

export interface BatchScriptRun {
  steps: readonly BatchStepOutcome[];
  total: number;
  onFailure: "abort" | "continue";
  durationMs: number;
  abortedAt?: string;
}

/** 脚本参数不符合契约时抛出;消息面向模型,需能据此自行修正。 */
export class BatchScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchScriptError";
  }
}

/**
 * 解析并校验 batch_tools 脚本参数。引用只允许指向更早的步骤(无前向引用、
 * 无自引用),因此校验通过后解释器按序执行即可满足任何数据依赖。
 */
export function parseBatchScript(raw: unknown): BatchScriptSpec {
  if (!isRecord(raw)) throw new BatchScriptError("batch_tools arguments must be an object");
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new BatchScriptError("steps must be a non-empty array");
  if (rawSteps.length > MAX_BATCH_STEPS)
    throw new BatchScriptError(`steps must contain at most ${MAX_BATCH_STEPS} entries`);
  const onFailure = raw.on_failure === undefined ? "abort" : raw.on_failure;
  if (onFailure !== "abort" && onFailure !== "continue")
    throw new BatchScriptError('on_failure must be "abort" or "continue"');
  const steps: BatchStepSpec[] = [];
  const knownIds = new Set<string>();
  rawSteps.forEach((item, index) => {
    if (!isRecord(item)) throw new BatchScriptError(`steps[${index}] must be an object`);
    const id = item.id;
    if (typeof id !== "string" || !id.trim())
      throw new BatchScriptError(`steps[${index}].id must be a non-empty string`);
    if (knownIds.has(id)) throw new BatchScriptError(`duplicate step id "${id}"`);
    const tool = item.tool;
    if (typeof tool !== "string" || !tool.trim())
      throw new BatchScriptError(`steps[${index}].tool must be a non-empty string`);
    if (tool === BATCH_TOOL_NAME) throw new BatchScriptError("steps may not invoke batch_tools recursively");
    const stepArguments = item.arguments === undefined ? {} : item.arguments;
    if (!isRecord(stepArguments)) throw new BatchScriptError(`steps[${index}].arguments must be an object`);
    for (const ref of collectStepRefs(stepArguments)) {
      if (!knownIds.has(ref))
        throw new BatchScriptError(
          `steps[${index}] references "${ref}"; only the ids of earlier steps in the same script can be referenced`,
        );
    }
    knownIds.add(id);
    steps.push({ id, tool, arguments: stepArguments });
  });
  return { steps, onFailure };
}

/** 收集参数中出现的全部步骤引用:整值占位 {"$ref":"id"} 与字符串内插 "${id}"。 */
export function* collectStepRefs(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* collectStepRefs(item);
    return;
  }
  if (isRecord(value)) {
    const ref = value[REF_KEY];
    if (typeof ref === "string" && Object.keys(value).length === 1) {
      yield normalizeRefToken(ref);
      return;
    }
    for (const item of Object.values(value)) yield* collectStepRefs(item);
    return;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(INTERPOLATION_RE)) yield normalizeRefToken(match[1]!);
  }
}

function normalizeRefToken(token: string): string {
  return token.endsWith(REF_OUTPUT_SUFFIX) ? token.slice(0, -REF_OUTPUT_SUFFIX.length) : token;
}

/**
 * 深度替换步骤参数中的引用。整值 {"$ref":"id"} 替换为被引用步骤的输出
 * (可解析为 JSON 时给出对象,否则保持字符串);字符串内插替换为输出原文。
 * 解析不到引用时保留占位原样,便于定位而不是静默损坏参数。
 */
export function substituteStepArguments(value: unknown, resolve: (stepId: string) => string | undefined): unknown {
  if (Array.isArray(value)) return value.map((item) => substituteStepArguments(item, resolve));
  if (isRecord(value)) {
    const ref = value[REF_KEY];
    if (typeof ref === "string" && Object.keys(value).length === 1) {
      const resolved = resolve(normalizeRefToken(ref));
      if (resolved === undefined) return value;
      return parseIfJson(resolved);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteStepArguments(item, resolve)]),
    );
  }
  if (typeof value === "string" && value.includes("${")) {
    return value.replace(INTERPOLATION_RE, (match, token: string) => {
      const resolved = resolve(normalizeRefToken(token));
      return resolved ?? match;
    });
  }
  return value;
}

function parseIfJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 把各步骤结果折叠成一条面向模型的聚合输出。已执行的步骤按序给出状态与
 * 内容;中止时列出被跳过的步骤,模型据此决定下一步而不需要补发调用。
 */
export function formatBatchScriptResult(run: BatchScriptRun): ToolResult {
  const failedCount = run.steps.filter((step) => !step.ok).length;
  const lines: string[] = [];
  lines.push(
    `batch_tools: executed ${run.steps.length}/${run.total} step(s), ${failedCount} failed` +
      (run.abortedAt !== undefined ? `, aborted at "${run.abortedAt}" (on_failure=${run.onFailure})` : "") +
      ` in ${run.durationMs}ms.`,
  );
  const skipped = run.total - run.steps.length;
  if (skipped > 0) lines.push(`Remaining ${skipped} step(s) skipped.`);
  for (const step of run.steps) {
    const status = step.ok ? "ok" : "FAILED";
    const duration = step.durationMs === undefined ? "" : ` (${step.durationMs}ms)`;
    lines.push("", `=== step ${step.id} [${step.tool}] ${status}${duration} ===`);
    // 步骤输出可能携带凭据(命令回显、报错信息),聚合进上下文前统一脱敏。
    if (step.error) lines.push(`error: ${redactSecretText(step.error)}`);
    if (step.output?.trim()) lines.push(redactSecretText(step.output.trimEnd()));
    else if (!step.error && step.summary) lines.push(redactSecretText(step.summary));
  }
  return {
    ok: failedCount === 0,
    output: lines.join("\n"),
    summary: `batch_tools ${run.steps.length}/${run.total} steps, ${failedCount} failed`,
    metadata: {
      script: true,
      stepsTotal: run.total,
      stepsExecuted: run.steps.length,
      stepsFailed: failedCount,
      ...(run.abortedAt !== undefined ? { abortedAt: run.abortedAt } : {}),
    },
  };
}

/**
 * batch_tools 的注册占位:真实执行由 ToolBatchExecutor 特判展开,每个步骤
 * 走完整的权限/hook/缓存管线。invoke 仅在执行器未接管的场景防御性报错。
 */
export function registerBatchTools(registry: { register(tool: ToolDefinition): void }): void {
  registry.register({
    name: BATCH_TOOL_NAME,
    description: [
      "Run a sequence of tool calls as one script and receive every result in a single response.",
      "Steps run in order; each step is subject to the same permission policy, hooks, and plan-mode limits as a direct call.",
      'A step\'s arguments may reference an earlier step\'s output: use {"$ref": "<step-id>"} as the whole value (JSON-parsed when possible) or "${<step-id>}" inside a string.',
      "Use it for short linear chains where later arguments depend on earlier results; emit independent calls directly in the same response instead.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: `Ordered tool steps executed one after another (at most ${MAX_BATCH_STEPS}).`,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique step id referenced by later steps, e.g. 'read-pkg'." },
              tool: { type: "string", description: "Name of an exposed tool to invoke for this step." },
              arguments: {
                type: "object",
                description:
                  'Arguments for the tool. Reference earlier outputs with {"$ref": "<step-id>"} or "${<step-id>}".',
              },
            },
            required: ["id", "tool"],
          },
        },
        on_failure: {
          type: "string",
          enum: ["abort", "continue"],
          description: "abort (default) stops at the first failed step; continue keeps executing remaining steps.",
        },
      },
      required: ["steps"],
    },
    permissionLevel: 0,
    system: true,
    kind: "command",
    maxOutputChars: 16_000,
    invoke: async () => ({
      ok: false,
      output: "",
      error: `${BATCH_TOOL_NAME} is interpreted by the tool executor and cannot run standalone.`,
      summary: "not executable",
    }),
  });
}
