import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeEvent } from "./types.js";

/**
 * Machine-readable event log for scripted (headless) runs.
 *
 * One JSON object per line, written to the path given by `--output`. The schema
 * is documented in `evals/README.md`; consumers (the Python evaluation harness)
 * rely on `kind` and, for `kind: "runtime_event"`, on `type`.
 *
 * Contract: `record()` never throws. A run must not fail because its audit log
 * could not be written; write failures are surfaced once, at `finish()`.
 */
export const EVENT_LOG_SCHEMA = "oran-event/1";

const ARGS_PREVIEW_CHARS = 400;
const ERROR_CHARS = 300;
const SUMMARY_CHARS = 200;
const MESSAGE_CHARS = 500;
const FINAL_TEXT_CHARS = 8_000;

export type RunOutcome = "completed" | "failed" | "cancelled" | "timeout";

export interface RunEndInput {
  outcome: RunOutcome;
  exitCode: number;
  durationMs: number;
  finalText: string;
  error?: string;
}

export interface JsonlEventLogHeader {
  model: string;
  workspace: string;
  prompt: string;
  productVersion: string;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export class JsonlEventLog {
  private readonly stream: WriteStream;
  private readonly startedAt = Date.now();
  private line = 0;
  private writeError: Error | undefined;
  private readonly toolsCalled = new Set<string>();
  private toolCallCount = 0;
  private assistantSteps = 0;
  private reportedSteps: number | undefined;
  private tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private finished = false;

  private constructor(private readonly path: string) {
    this.stream = createWriteStream(path, { flags: "w", encoding: "utf8" });
    this.stream.on("error", (error: Error) => {
      this.writeError ??= error;
    });
  }

  /** Opens the log for writing. Throws when the target path cannot be created. */
  static open(path: string, header: JsonlEventLogHeader): JsonlEventLog {
    const target = resolve(path);
    mkdirSync(dirname(target), { recursive: true });
    const log = new JsonlEventLog(target);
    log.write({
      kind: "run_start",
      model: header.model,
      workspace: header.workspace,
      promptChars: header.prompt.length,
      productVersion: header.productVersion,
    });
    return log;
  }

  get outputPath(): string {
    return this.path;
  }

  record(event: RuntimeEvent): void {
    try {
      this.accumulate(event);
      const payload = payloadFor(event);
      if (!payload) return;
      this.write({ kind: "runtime_event", ts: event.timestamp, type: event.type, ...payload });
    } catch {
      // Audit logging must never break the agent loop.
    }
  }

  async finish(input: RunEndInput): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const finalText = truncate(input.finalText, FINAL_TEXT_CHARS);
    this.write({
      kind: "run_end",
      outcome: input.outcome,
      exitCode: input.exitCode,
      durationMs: input.durationMs || Date.now() - this.startedAt,
      steps: this.reportedSteps ?? this.assistantSteps,
      toolCalls: this.toolCallCount,
      tools: [...this.toolsCalled].sort(),
      tokens: { ...this.tokens, total: this.tokens.input + this.tokens.output },
      finalText,
      finalTextChars: input.finalText.length,
      finalTextTruncated: finalText.length < input.finalText.length,
      ...(input.error ? { error: truncate(input.error, MESSAGE_CHARS) } : {}),
    });
    await new Promise<void>((settle) => {
      this.stream.end(() => settle());
    });
  }

  /** Set when the log could not be written; `finish()` still attempts a final line. */
  get writeFailure(): Error | undefined {
    return this.writeError;
  }

  private accumulate(event: RuntimeEvent): void {
    switch (event.type) {
      case "tool_start":
        this.toolCallCount += 1;
        this.toolsCalled.add(event.call.name);
        return;
      case "assistant_end":
        this.assistantSteps += 1;
        this.tokens = tokenTotals(event.usage, this.tokens);
        return;
      case "completed":
        this.reportedSteps = event.steps;
        this.tokens = tokenTotals(event, this.tokens);
        return;
      default:
        return;
    }
  }

  private write(record: Record<string, unknown>): void {
    if (this.writeError) return;
    this.line += 1;
    const { ts, ...rest } = record;
    const payload = {
      schema: EVENT_LOG_SCHEMA,
      line: this.line,
      ts: typeof ts === "string" ? ts : new Date().toISOString(),
      ...rest,
    };
    this.stream.write(`${JSON.stringify(payload)}\n`);
  }
}

function payloadFor(event: RuntimeEvent): Record<string, unknown> | undefined {
  switch (event.type) {
    case "state":
      return { state: event.state };
    case "tool_start":
      return {
        tool: event.call.name,
        index: event.index,
        permissionLevel: event.permissionLevel,
        argsPreview: truncate(compactJson(event.call.arguments), ARGS_PREVIEW_CHARS),
      };
    case "tool_result":
      return {
        tool: event.call.name,
        index: event.index,
        ok: event.result.ok,
        durationMs: event.result.durationMs,
        outputChars: event.result.output.length,
        ...(event.result.summary ? { summary: truncate(event.result.summary, SUMMARY_CHARS) } : {}),
        ...(event.result.error ? { error: truncate(event.result.error, ERROR_CHARS) } : {}),
      };
    case "assistant_end":
      return {
        step: event.step,
        streamed: event.streamed,
        textChars: event.text.length,
        toolCallCount: event.toolCalls.length,
        usage: event.usage,
        ...(event.finishReason ? { finishReason: event.finishReason } : {}),
      };
    case "assistant_abort":
      return { step: event.step, message: truncate(event.message, MESSAGE_CHARS), finishReason: event.finishReason };
    case "retry":
      return {
        step: event.step,
        attempt: event.attempt,
        nextAttempt: event.nextAttempt,
        maxRetries: event.maxRetries,
        message: truncate(event.message, MESSAGE_CHARS),
      };
    case "context_compaction":
      return {
        phase: event.phase,
        reason: event.reason,
        ...(event.beforeTokens !== undefined ? { beforeTokens: event.beforeTokens } : {}),
        ...(event.afterTokens !== undefined ? { afterTokens: event.afterTokens } : {}),
        ...(event.replacementCount !== undefined ? { replacementCount: event.replacementCount } : {}),
      };
    case "error":
      return {
        message: truncate(event.message, MESSAGE_CHARS),
        ...(event.step !== undefined ? { step: event.step } : {}),
        ...(event.source !== undefined ? { source: event.source } : {}),
      };
    case "cancelled":
      return { message: truncate(event.message, MESSAGE_CHARS) };
    case "completed":
      return {
        steps: event.steps,
        elapsedMs: event.elapsedMs,
        modelElapsedMs: event.modelElapsedMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    default:
      return undefined;
  }
}

function tokenTotals(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  previous: TokenTotals,
): TokenTotals {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return {
    // Context-compaction and retry rounds can report usage more than once; keep the
    // largest observed values so totals describe the heaviest round, not a sum.
    input: Math.max(previous.input, input),
    output: Math.max(previous.output, output),
    cacheRead: Math.max(previous.cacheRead, usage.cacheReadTokens ?? 0),
    cacheWrite: Math.max(previous.cacheWrite, usage.cacheWriteTokens ?? 0),
  };
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
