import type { Message, ToolCall } from "../types.js";

export const HOOK_EVENTS = [
  "session_start",
  "session_end",
  "turn_start",
  "before_model_request",
  "after_model_response",
  "turn_end",
  "before_tool_call",
  "after_tool_call",
  "process_exit",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_ACTION_TYPES = ["command", "prompt", "http", "subagent"] as const;
export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

export const HOOK_ERROR_POLICIES = ["ignore", "fail", "reject"] as const;
export type HookErrorPolicy = (typeof HOOK_ERROR_POLICIES)[number];

export interface HookAction {
  type: HookActionType;
  command?: string;
  prompt?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HookConfig {
  id?: string;
  event: HookEvent;
  if?: string;
  action: HookAction;
  intercept?: boolean;
  once?: boolean;
  async?: boolean;
  onError?: HookErrorPolicy;
}

export type HookConditionLogic = "all" | "any";

export interface HookCondition {
  logic: HookConditionLogic;
  clauses: HookConditionClause[];
}

export type HookOperator = "==" | "!=" | "=~" | "glob";

export interface HookConditionClause {
  field: string;
  operator: HookOperator;
  negate: boolean;
  value: string;
}

export interface HookEventContext {
  event: HookEvent;
  tool?: ToolCall;
  filePath?: string;
  userPrompt?: string;
  assistantText?: string;
  workspace?: string;
  model?: string;
}

export interface HookResult {
  output: string;
  ok: boolean;
  intercept: boolean;
}

export interface HookValidationError {
  index: number;
  id?: string;
  message: string;
}

export type HookSubAgentExecutor = (prompt: string, context: HookEventContext) => Promise<HookResult>;

export interface HookDispatchResult {
  results: HookResult[];
  intercepted: boolean;
  interceptReason?: string;
}

export interface HookNotice {
  event: HookEvent;
  text: string;
}

export type HookNoticeSink = {
  append(notice: HookNotice): void;
  drain(): HookNotice[];
};

export interface HookEngineDeps {
  runCommand: (
    command: string,
    env: Record<string, string>,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string }>;
  fetch: (
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; body: string }>;
  subAgentExecutor?: HookSubAgentExecutor;
  log?: (message: string) => void;
  notices: HookNoticeSink;
  sessionMessages?: () => readonly Message[];
}
