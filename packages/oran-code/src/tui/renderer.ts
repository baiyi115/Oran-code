import type { TuiState } from "./types.js";
import type { ApprovalResponse, RuntimeEvent, ToolCall } from "../types.js";
import type { PromptOutputHooks } from "../renderer.js";
import type { SubagentOrigin } from "../subagent/types.js";
import { appendSystemMessage, appendUserMessage, reduceRuntimeEvent } from "./message-reducer.js";

export type ApprovalHandler = (call: ToolCall, level: number, description: string, origin: SubagentOrigin) => Promise<ApprovalResponse>;
export type ApprovalCancelHandler = () => void;

export interface TuiRendererLayout {
  redraw(state: TuiState): void;
  resetStatic?(): void;
}

export class TuiTranscriptRenderer {
  private readonly layout: TuiRendererLayout;
  private readonly state: TuiState;
  private approvalHandler: ApprovalHandler | undefined;
  private approvalCancelHandler: ApprovalCancelHandler | undefined;

  constructor(layout: TuiRendererLayout, state: TuiState, approvalHandler?: ApprovalHandler) {
    this.layout = layout;
    this.state = state;
    this.approvalHandler = approvalHandler;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  attachPrompt(_hooks: PromptOutputHooks | undefined): void {
    // The Ink app's live frame owns the prompt and redraw lifecycle; the
    // transcript renderer only reduces events and invalidates that frame.
  }

  setApprovalCancelHandler(handler: ApprovalCancelHandler): void {
    this.approvalCancelHandler = handler;
  }

  cancelApproval(): void {
    this.approvalCancelHandler?.();
  }

  render(event: RuntimeEvent): void {
    reduceRuntimeEvent(this.state, event);
    this.redraw();
  }

  user(prompt: string, queued = false): void {
    appendUserMessage(this.state, prompt, queued);
    this.redraw();
  }

  status(message: string): void {
    this.state.session.status = message;
    this.redraw();
  }

  markdown(title: string, content: string): void {
    appendSystemMessage(this.state, `${title}\n${content}`, title.toLowerCase() === "plan" ? "plan" : "system");
    this.redraw();
  }

  error(message: string): void {
    appendSystemMessage(this.state, message, "error");
    this.state.session.status = "error";
    this.redraw();
  }

  clearTranscript(): void {
    this.state.transcript.splice(0);
    this.state.expandedToolGroupIds.clear();
    this.state.assistantMessageId = undefined;
    this.state.thoughtMessageId = undefined;
    this.state.streaming = false;
    this.layout.resetStatic?.();
    this.redraw();
  }

  approval(call: ToolCall, level: number, description: string, origin: SubagentOrigin): Promise<ApprovalResponse> | void {
    this.state.session.status = "approval required";
    return this.approvalHandler?.(call, level, description, origin);
  }

  redraw(): void {
    this.layout.redraw(this.state);
  }

}
