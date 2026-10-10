import type { ApprovalResponse, ToolCall } from "./types.js";
import type { SubagentOrigin } from "./subagent/types.js";
import type { SessionRenderer } from "./renderer.js";

export interface PendingApproval {
  readonly call: ToolCall;
  readonly level: number;
  readonly description: string;
  readonly requestId: string;
  readonly origin: SubagentOrigin;
  readonly resolve: (response: ApprovalResponse) => void;
  presented: boolean;
  settled: boolean;
}

export interface ApprovalQueueDependencies {
  /** The TUI replaces the renderer at startup, so the current instance comes from a getter. */
  readonly renderer: () => SessionRenderer;
  /** Approvals may be queued for presentation only when readline or the TUI is available. */
  readonly isInteractive: () => boolean;
}

/**
 * FIFO approval queue. Only the head of the queue is presented at any time; when the
 * main task is cancelled, approvals are cancelled in bulk by origin.
 * Extracted from TerminalSession with behaviour unchanged.
 */
export class ApprovalQueue {
  private readonly pending: PendingApproval[] = [];

  constructor(private readonly deps: ApprovalQueueDependencies) {}

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  hasPendingForMainOrigin(): boolean {
    return this.pending.some((item) => item.origin.kind === "main");
  }

  request(
    call: ToolCall,
    level: number,
    description: string,
    origin: SubagentOrigin,
    requestId: string,
  ): Promise<ApprovalResponse> {
    // Non-interactive sessions (e.g. `oran run --once`) have no readline or
    // TUI to present an approval prompt. Auto-deny rather than hanging forever.
    if (!this.deps.isInteractive()) {
      this.deps
        .renderer()
        .error(
          `approval required for ${call.name} but no interactive session is available; use --approve-all to run non-interactively`,
        );
      return Promise.resolve(false);
    }
    return new Promise<ApprovalResponse>((resolveApproval) => {
      this.pending.push({
        call,
        level,
        description,
        requestId,
        origin,
        resolve: resolveApproval,
        presented: false,
        settled: false,
      });
      this.presentNext();
    });
  }

  private presentNext(): void {
    const pending = this.pending[0];
    if (!pending || pending.presented || pending.settled) return;
    pending.presented = true;
    const rendered = this.deps.renderer().approval(pending.call, pending.level, pending.description, pending.origin);
    if (rendered && typeof rendered.then === "function") {
      void rendered.then((response) => this.settle(pending, response));
    }
  }

  private settle(pending: PendingApproval, response: ApprovalResponse): void {
    if (pending.settled) return;
    const index = this.pending.indexOf(pending);
    if (index < 0) return;
    pending.settled = true;
    const wasHead = index === 0;
    this.pending.splice(index, 1);
    pending.resolve(response);
    if (wasHead) this.presentNext();
  }

  cancelForOrigin(origin: SubagentOrigin): void {
    const head = this.pending[0];
    const cancelled = this.pending.filter((pending) => sameApprovalOrigin(pending.origin, origin));
    if (!cancelled.length) return;
    const cancelledHead = head !== undefined && cancelled.includes(head);
    for (const pending of cancelled) {
      pending.settled = true;
      const index = this.pending.indexOf(pending);
      if (index >= 0) this.pending.splice(index, 1);
      pending.resolve(false);
    }
    if (cancelledHead) this.deps.renderer().cancelApproval?.();
    this.presentNext();
  }

  resolveFromInput(value: string): void {
    const pending = this.pending[0];
    if (!pending) return;
    const answer = value.toLowerCase();
    if (answer === "y" || answer === "yes") {
      this.settle(pending, true);
    } else if (answer === "a" || answer === "always") {
      this.settle(pending, "always");
    } else if (answer === "n" || answer === "no" || answer === "esc" || answer === "") {
      this.settle(pending, false);
    } else {
      this.deps.renderer().status("Please answer y, a, or n.", "yellow");
    }
  }
}

export function isApprovalAnswer(value: string): boolean {
  return ["y", "yes", "a", "always", "n", "no", "esc"].includes(value.toLowerCase());
}

function sameApprovalOrigin(left: SubagentOrigin, right: SubagentOrigin): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "main" || right.kind === "main") return true;
  if (left.taskId && right.taskId) return left.taskId === right.taskId;
  if (left.kind === "teammate" && right.kind === "teammate") {
    return left.teamName === right.teamName && left.name === right.name;
  }
  return left.name === right.name;
}
