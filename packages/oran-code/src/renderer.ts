import { clearLine, cursorTo } from "node:readline";
import type { Writable } from "node:stream";
import type { ApprovalResponse, RuntimeEvent, ToolCall, ToolResult, VerificationResult } from "./types.js";

export interface PromptOutputHooks {
  before: () => void;
  after: () => void;
}

/**
 * Transcript renderer for a normal terminal session.
 *
 * It only uses foreground ANSI styles. The terminal owns its background and
 * the line editor is temporarily cleared while asynchronous output arrives.
 */
export type RendererStyle = "dim" | "bold" | "cyan" | "boldCyan" | "green" | "yellow" | "red" | "boldRed";

export interface SessionRenderer {
  attachPrompt(hooks: PromptOutputHooks | undefined): void;
  render(event: RuntimeEvent): void;
  user(prompt: string, queued?: boolean): void;
  status(message: string, style?: RendererStyle): void;
  markdown(title: string, content: string): void;
  error(message: string): void;
  clearTranscript(): void;
  approval(call: ToolCall, level: number, description: string): Promise<ApprovalResponse> | void;
  cancelApproval?(): void;
}

export class TerminalRenderer implements SessionRenderer {
  private readonly output: Writable;
  private readonly colorEnabled: boolean;
  private hooks: PromptOutputHooks | undefined;
  private assistantOpen = false;
  private assistantText = "";

  constructor(output: Writable = process.stdout) {
    this.output = output;
    this.colorEnabled = Boolean((output as NodeJS.WriteStream).isTTY);
  }

  attachPrompt(hooks: PromptOutputHooks | undefined): void {
    this.hooks = hooks;
  }

  user(prompt: string, queued = false): void {
    this.block(`\nYou${queued ? " [queued]" : ""} > ${prompt}\n`);
  }

  status(message: string, style: Style = "dim"): void {
    this.block(`${paint(message, style, this.colorEnabled)}\n`);
  }

  markdown(title: string, content: string): void {
    const lines: string[] = [];
    if (title) lines.push(paint(title, "bold", this.colorEnabled));
    if (content.trim()) lines.push(content.trim());
    this.block(`${lines.join("\n")}\n`);
  }

  state(state: string): void {
    const style: Style = state === "completed" || state === "ready"
      ? "green"
      : state === "failed" || state === "cancelled"
        ? "red"
        : "cyan";
    this.status(`[${state}]`, style);
  }

  assistantStart(model: string, source: string): void {
    this.finishAssistantIfOpen();
    this.beginExternal();
    const label = source === "plan" ? "Plan" : model ? `Oran code [${model}]` : "Oran code";
    this.write(`${paint(`\n${label} > `, "boldCyan", this.colorEnabled)}`);
    this.assistantOpen = true;
    this.assistantText = "";
  }

  assistantDelta(text: string): void {
    if (!text) return;
    if (!this.assistantOpen) this.assistantStart("", "turn");
    this.write(text);
    this.assistantText += text;
  }

  assistantEnd(text: string): void {
    if (!this.assistantOpen) {
      if (text) {
        this.assistantStart("", "turn");
        this.write(text);
      }
      this.finishAssistant();
      return;
    }
    if (text && text !== this.assistantText) {
      this.write(text.slice(this.assistantText.length));
    }
    this.finishAssistant();
  }

  assistantAbort(message: string): void {
    if (!this.assistantOpen) {
      this.status(`[${message}]`, "yellow");
      return;
    }
    this.write(`\n${paint(`[${message}]`, "yellow", this.colorEnabled)}\n`);
    this.assistantOpen = false;
    this.assistantText = "";
    this.endExternal();
  }

  plan(plan: string): void {
    this.markdown("Plan", plan);
  }

  toolStart(call: ToolCall, permissionLevel: number): void {
    this.finishAssistantIfOpen();
    const args = JSON.stringify(call.arguments, undefined, 0);
    this.block(`  ${paint("->", "yellow", this.colorEnabled)} ${call.name} L${permissionLevel} ${args}\n`);
  }

  toolResult(call: ToolCall, result: ToolResult): void {
    const marker = result.ok ? "ok" : "failed";
    const style: Style = result.ok ? "green" : "red";
    const duration = result.durationMs === undefined ? "" : ` (${result.durationMs}ms)`;
    const summary = result.summary ?? result.error ?? marker;
    const output = result.output?.trim();
    const detail = output ? `\n     | ${truncate(output, 1600)}` : "";
    this.block(`     ${paint(marker, style, this.colorEnabled)}: ${summary}${duration}${detail}\n`);
    void call;
  }

  verify(results: readonly VerificationResult[]): void {
    const lines = results.map((result) => {
      const style: Style = result.passed ? "green" : "red";
      const output = result.output.trim();
      return `  ${paint("verify", style, this.colorEnabled)} ${result.command} exit=${result.exitCode} (${result.durationMs}ms)${output ? `\n  | ${truncate(output, 600)}` : ""}`;
    });
    if (lines.length) this.block(`${lines.join("\n")}\n`);
  }

  retry(message: string, nextAttempt: number, maxRetries: number): void {
    // Non-TUI path: show the failure immediately, then the retry notice.
    this.status(`Attempt failed: ${message}`, "yellow");
    this.status(`[retry ${nextAttempt}/${maxRetries}] retrying...`, "yellow");
  }

  approval(call: ToolCall, level: number, description: string): void {
    const args = JSON.stringify(call.arguments, undefined, 2);
    this.block(
      `${paint("Approval required", "yellow", this.colorEnabled)}: ${call.name} (L${level})\n` +
      `${description}\n${truncate(args, 1200)}\n` +
      "Reply y to allow once, a to always allow this exact tool request, or n to reject.\n",
    );
  }

  error(message: string): void {
    this.block(`${paint(`Error: ${message}`, "boldRed", this.colorEnabled)}\n`);
  }

  clearTranscript(): void {
    this.beginExternal();
    this.write("\u001b[2J\u001b[H");
    this.endExternal();
  }

  render(event: RuntimeEvent): void {
    switch (event.type) {
      case "state": this.state(event.state); break;
      case "assistant_start": this.assistantStart(event.model, event.source); break;
      case "assistant_delta": this.assistantDelta(event.text); break;
      case "thought_start": this.status("+ Thinking...", "cyan"); break;
      case "thought_delta": break;
      case "thought_end": break;
      case "assistant_end": this.assistantEnd(event.text); break;
      case "assistant_abort": this.assistantAbort(event.message); break;
      case "plan": if (!event.streamed) this.plan(event.plan); break;
      case "plan_complete": this.plan(event.plan); this.status(event.autoExecute ? "Plan complete; executing..." : "Plan complete.", "cyan"); break;
      case "tool_start": this.toolStart(event.call, event.permissionLevel); break;
      case "tool_result": this.toolResult(event.call, event.result); break;
      case "verify": this.verify(event.results); break;
      case "retry": this.retry(event.message, event.nextAttempt, event.maxRetries); break;
      case "context_compaction": {
        if (event.phase === "started") {
          this.status(
            event.reason === "emergency"
              ? "Context limit reached; compacting before retry..."
              : "Compacting context...",
            "cyan",
          );
        } else if (event.phase === "completed") {
          const change = event.beforeTokens !== undefined && event.afterTokens !== undefined
            ? `${event.beforeTokens} -> ${event.afterTokens} estimated tokens`
            : "token estimate unavailable";
          this.status(`Context compacted (${change}).`, "green");
        } else if (event.phase === "offloaded") {
          if ((event.replacementCount ?? 0) > 0) {
            this.status(`Offloaded ${event.replacementCount} large tool result(s) from active context.`, "cyan");
          }
          if (event.message) this.error(`Tool-result offload was incomplete: ${event.message}`);
        } else if (/cancelled|canceled|aborted/i.test(event.message ?? "")) {
          this.status(event.message ?? "Context compaction cancelled.", "yellow");
        } else {
          this.error(`Context compaction failed (${event.reason}): ${event.message ?? "unknown compaction error"}`);
        }
        break;
      }
      case "error": this.error(event.message); break;
      case "completed": this.status(`[completed in ${event.steps} step(s), ${event.tokensUsed} token(s)]`, "green"); break;
      case "cancelled": this.status(`[cancelled] ${event.message}`, "yellow"); break;
      case "approval_request": break;
      case "log": this.status(event.message); break;
    }
  }

  private block(text: string): void {
    this.finishAssistantIfOpen();
    this.beginExternal();
    this.write(text);
    this.endExternal();
  }

  private beginExternal(): void {
    this.hooks?.before();
  }

  private endExternal(): void {
    this.hooks?.after();
  }

  private finishAssistantIfOpen(): void {
    if (this.assistantOpen) this.finishAssistant();
  }

  private finishAssistant(): void {
    this.write("\n");
    this.assistantOpen = false;
    this.assistantText = "";
    this.endExternal();
  }

  private write(text: string): void {
    this.output.write(text);
  }
}


export function createPromptHooks(output: NodeJS.WriteStream, redraw: () => void): PromptOutputHooks {
  return {
    before: () => {
      if (output.isTTY) {
        clearLine(output, 0);
        cursorTo(output, 0);
      }
    },
    after: redraw,
  };
}

type Style = RendererStyle;

function paint(value: string, style: Style, enabled: boolean): string {
  if (!enabled) return value;
  const codes: Record<Style, string> = {
    dim: "2",
    bold: "1",
    cyan: "36",
    boldCyan: "1;36",
    green: "32",
    yellow: "33",
    red: "31",
    boldRed: "1;31",
  };
  return `\u001b[${codes[style]}m${value}\u001b[0m`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}
