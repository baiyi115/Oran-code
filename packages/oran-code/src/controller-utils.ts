import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { structuredPermissionDenial, type ApprovalDecision } from "./security.js";
import { isWriteToolName } from "./tools.js";
import type { ContextManager } from "./context-manager.js";
import type { AgentLoop } from "./loop.js";
import type { Message, ModelResponse, ToolCall, ToolCallComplete, ToolResult } from "./types.js";
import { formatErrorMessage } from "./error-format.js";
import { systemReminderMessage } from "./system-prompt.js";
import { PROJECT_STATE_DIR_NAMES } from "./paths.js";

const execFileAsync = promisify(execFile);

export const PLAN_COMPLETE_MARKERS = [
  "PLAN_COMPLETE",
  "<<PLAN_COMPLETE>>",
  "<plan_complete>",
  "</plan_complete>",
] as const;

export function permissionDeniedResult(call: ToolCall, decision: ApprovalDecision): ToolResult {
  return {
    ok: false,
    output: structuredPermissionDenial(call, decision),
    error: decision.reason,
    summary: `permission denied: ${decision.reason}`,
    metadata: { permissionDenied: true, permissionSource: decision.source },
  };
}

export function planModeDeniedResult(call: ToolCall): ToolResult {
  return permissionDeniedResult(call, {
    verdict: "deny",
    reason: "plan mode only allows readonly tools and write_plan",
    source: "permission-mode",
    level: 4,
  });
}

export function toolUnavailableResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    output: "",
    error: `tool unavailable in the current runtime: ${call.name}`,
    summary: "tool unavailable",
    metadata: { toolUnavailable: true },
  };
}

export function isRetryableModelStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_MAX_MS = 8_000;

/** Exponential retry delay with a small jitter so concurrent clients do not retry in lockstep. */
export function modelRetryDelayMs(attempt: number, random = Math.random): number {
  const exponent = Math.max(0, Math.trunc(attempt));
  const base = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** exponent, RETRY_BACKOFF_MAX_MS);
  return base + Math.floor(Math.max(0, Math.min(1, random())) * 250);
}

/** Wait without making cancellation wait for the backoff timer to expire. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("operation aborted", "AbortError"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("operation aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function ensureCallId(call: ToolCall, contextManager: ContextManager): string {
  if (call.id) return call.id;
  const id = contextManager.claimToolCallId();
  call.id = id;
  return id;
}

/** 从工具参数中提取文件路径，供 Hook 条件匹配与环境变量注入。 */
export function extractToolFilePath(call: ToolCall): string {
  for (const key of ["path", "file_path", "target_path"]) {
    const value = call.arguments[key];
    if (typeof value === "string" && value.trim()) return value.trim().replaceAll("\\\\", "/");
  }
  return "";
}

export function normalizeCallId(call: ToolCall, contextManager: ContextManager): ToolCall {
  return { ...call, id: contextManager.claimToolCallId(call.id) };
}

export function parseCompletedToolCall(raw: ToolCallComplete): ToolCall {
  if (!Number.isInteger(raw.index) || raw.index < 0) {
    throw new Error(`invalid completed tool-call index: ${String(raw.index)}`);
  }
  if (!raw.name.trim()) throw new Error(`completed tool call ${raw.index} is missing a name`);
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(raw.argumentsJson);
  } catch (error) {
    throw new Error(`invalid arguments for completed tool call ${raw.index}: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error(`invalid arguments for completed tool call ${raw.index}: expected an object`);
  }
  return {
    ...(raw.id ? { id: raw.id } : {}),
    name: raw.name,
    arguments: argumentsValue as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
}

export function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    JSON.stringify(left.arguments) === JSON.stringify(right.arguments)
  );
}

export function tokenBudgetMessage(loop: AgentLoop, budget: number): string {
  return [
    `Token budget reached after ${loop.turns} model iteration(s): ${loop.tokensUsed.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")} task tokens.`,
    "Oran code preserved the completed response and stopped before another model request.",
    "Start a new session or use /compact (preferred) or /clear to reduce prior context, lower the reasoning effort, or increase agent.tokenBudget.",
  ].join(" ");
}

export function withRuntimeReminders(messages: readonly Message[], reminders: readonly string[]): Message[] {
  // 浅拷贝即可:消息对象入列后不可变,这里只追加 reminder,不改写元素。
  const copy = [...messages];
  // 运行时提醒追加到请求末尾（而非插在对话之前）：每轮变化的提醒文本不再击穿
  // 稳定前缀 [system + 对话] 的字节一致性，DeepSeek/OpenAI 前缀缓存可覆盖整段对话。
  if (reminders.length) copy.push(systemReminderMessage(reminders));
  return copy;
}

export function usageAnchorMessages(messages: readonly Message[], response: ModelResponse): Message[] {
  return [...messages, { role: "assistant", content: response.text, toolCalls: response.toolCalls }];
}

export function summarizeArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) => [key, summarizeValue(value)]));
}

export function formatCallArguments(argumentsValue: Record<string, unknown>): string {
  return Object.entries(argumentsValue)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

export function summarizeToolCalls(calls: readonly ToolCall[]): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: summarizeArguments(call.arguments),
  }));
}

export function summarizeMessageTail(messages: readonly Message[]): Array<Record<string, unknown>> {
  return messages.slice(-6).map((message) => ({
    role: message.role,
    name: message.name,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls?.length ?? 0,
    contentBytes: Buffer.byteLength(message.content ?? "", "utf8"),
  }));
}

export function fingerprintRequest(messages: readonly Message[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        messages.map((message) => ({
          role: message.role,
          name: message.name,
          toolCallId: message.toolCallId,
          content: message.content ?? "",
          toolCalls: message.toolCalls?.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        })),
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

export function fingerprintResponse(response: ModelResponse): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: response.text,
        reasoning: response.reasoning ?? "",
        toolCalls: response.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        finishReason: response.finishReason,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, item]) => [key, summarizeValue(item)]),
    );
  }
  return value;
}

export async function fileHash(
  workspace: string,
  call: ToolCall,
): Promise<{ path: string; hash: string | null } | undefined> {
  if (!isWriteToolName(call.name)) return undefined;
  const path = resolve(workspace, String(call.arguments.path ?? ""));
  const root = resolve(workspace);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  try {
    const data = await readFile(path);
    return { path, hash: createHash("sha256").update(data).digest("hex") };
  } catch {
    return { path, hash: null };
  }
}

const FINGERPRINT_IGNORED = new Set([
  ...PROJECT_STATE_DIR_NAMES,
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "__pycache__",
]);
const WORKSPACE_FINGERPRINT_TIMEOUT_MS = 750;
const WORKSPACE_FINGERPRINT_MAX_ENTRIES = 10_000;

export function inferToolKind(name: string): "readonly" | "write" | "command" {
  if (isWriteToolName(name)) return "write";
  if (["list_files", "read_file", "glob_files", "search_code", "git_status", "get_diff"].includes(name))
    return "readonly";
  return "command";
}

export async function workspaceFingerprint(root: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: WORKSPACE_FINGERPRINT_TIMEOUT_MS,
      windowsHide: true,
    });
    return `git:${result.stdout.split(/\r?\n/).filter(Boolean).sort().join("\n")}`;
  } catch {
    return collectWorkspaceEntries(resolve(root));
  }
}

async function collectWorkspaceEntries(root: string): Promise<string> {
  const entries: string[] = [];
  await collectWorkspaceEntriesRecursive(root, root, entries, Date.now() + WORKSPACE_FINGERPRINT_TIMEOUT_MS);
  return `scan:${entries.sort().join("\n")}`;
}

async function collectWorkspaceEntriesRecursive(
  root: string,
  directory: string,
  entries: string[],
  deadline: number,
): Promise<void> {
  if (entries.length >= WORKSPACE_FINGERPRINT_MAX_ENTRIES || Date.now() > deadline) return;
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (entries.length >= WORKSPACE_FINGERPRINT_MAX_ENTRIES || Date.now() > deadline) return;
    if (FINGERPRINT_IGNORED.has(child.name)) continue;
    const path = resolve(directory, child.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (child.isDirectory()) {
      entries.push(`d:${relativePath}`);
      await collectWorkspaceEntriesRecursive(root, path, entries, deadline);
      continue;
    }
    if (!child.isFile()) continue;
    try {
      const metadata = await stat(path);
      entries.push(`f:${relativePath}:${metadata.size}:${metadata.mtimeMs}`);
    } catch {
      // Files disappearing during a command are represented by their absence.
    }
  }
}

export function isPlanComplete(text: string): boolean {
  // Require an explicit protocol marker. Free-form phrases such as
  // "plan complete" in ordinary replies must not trigger auto-execution.
  const normalized = text.replace(/\r/g, "");
  for (const marker of PLAN_COMPLETE_MARKERS) {
    if (normalized.includes(marker)) return true;
  }
  return false;
}

export function extractPlanText(text: string): string {
  let plan = text.replace(/\r/g, "");
  for (const marker of PLAN_COMPLETE_MARKERS) {
    plan = plan.split(marker).join("");
  }
  plan = plan
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !/^plan\s+complete$/i.test(trimmed);
    })
    .join("\n");
  return plan.trim();
}
