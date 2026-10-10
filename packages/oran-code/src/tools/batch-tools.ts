import type { ToolDefinition, ToolResult } from "../types.js";
import { isRecord } from "../types.js";
import { redactSecretText } from "../formatting.js";

export const BATCH_TOOL_NAME = "batch_tools";
/**
 * Maximum steps allowed in a single script: no turn boundary advances between steps, so a hard
 * cap is required to prevent unbounded execution.
 */
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

/**
 * Thrown when script arguments violate the contract; the message is model-facing, so it must
 * carry enough detail for the model to correct the call itself.
 */
export class BatchScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchScriptError";
  }
}

/**
 * Parse and validate batch_tools script arguments. References may only point at earlier steps
 * (no forward references, no self-references), so once validation passes the interpreter can
 * execute in order and satisfy any data dependency.
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

/**
 * Collect every step reference appearing in the arguments: whole-value placeholders
 * {"$ref":"id"} and string interpolations "${id}".
 */
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
 * Deeply substitute references in the step arguments. A whole-value {"$ref":"id"} is replaced by
 * the referenced step's output (an object when it parses as JSON, otherwise the string);
 * string interpolations are replaced by the raw output. A reference that cannot be resolved is
 * left as the placeholder, so it is easy to locate rather than silently corrupting the arguments.
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
 * Fold the per-step results into a single model-facing aggregate output. Executed steps are
 * listed in order with status and content; on abort the skipped steps are listed too, so the
 * model can decide what to do next without re-sending a call.
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
    // Step output can carry credentials (command echo, error text); redact uniformly before
    // aggregating into the context.
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
 * Registration placeholder for batch_tools: the real execution is expanded by a special case in
 * ToolBatchExecutor, sending each step through the full permission/hook/cache pipeline. invoke
 * only raises a defensive error in the scenarios the executor has not taken over.
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
