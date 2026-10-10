import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { structuredPermissionDenial, type ApprovalDecision } from "./security.js";
import { isWriteToolName } from "./tools.js";
import type { ContextManager } from "./context-manager.js";
import type { AgentLoop } from "./loop.js";
import type { Message, ModelResponse, ModelRetryCategory, ToolCall, ToolCallComplete, ToolResult } from "./types.js";
import { formatErrorMessage } from "./error-format.js";
import { ModelRequestError, SseIdleTimeoutError } from "./provider.js";
import { PLAN_COMPLETE_MARKERS } from "./message-utils.js";
import { systemReminderMessage } from "./system-prompt.js";
import { PROJECT_STATE_DIR_NAMES } from "./paths.js";

const execFileAsync = promisify(execFile);

export { PLAN_COMPLETE_MARKERS } from "./message-utils.js";

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

/**
 * The model returned an empty response (some compatible endpoints emit a transient empty
 * completion): treat it as a retryable error.
 */
export class EmptyModelResponseError extends Error {
  constructor() {
    super("model returned an empty response");
    this.name = "EmptyModelResponseError";
  }
}

/**
 * A completed tool call whose arguments cannot be parsed (invalid JSON / invalid structure);
 * the call is not executable.
 */
export class ToolCallParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolCallParseError";
  }
}

const NETWORK_FAILURE_PATTERN =
  /fetch failed|network|econnreset|econnrefused|econnaborted|enotfound|eai_again|etimedout|socket hang up|other side closed|premature close|undici/i;

/**
 * Classifies model-request failures into stable categories, reused by retry events, diagnostics
 * and per-category statistics.
 * The classification only answers "which kind of failure happened"; it does not change the retry
 * decision (that still lives in streamWithRetry).
 */
export function classifyModelRetry(error: unknown): ModelRetryCategory {
  if (error instanceof ModelRequestError) {
    if (error.status === 429) return "rate_limit";
    if (error.status === 408) return "timeout";
    if (error.status >= 500) return "http_5xx";
    return "http_4xx";
  }
  if (error instanceof SseIdleTimeoutError) return "timeout";
  if (error instanceof EmptyModelResponseError) return "empty";
  if (error instanceof ToolCallParseError) return "parse";
  // ProviderContractError is defined in turn-requester (stream protocol violation); matching on
  // the name avoids a reverse dependency.
  if (error instanceof Error && error.name === "ProviderContractError") return "contract";
  if (error instanceof Error && NETWORK_FAILURE_PATTERN.test(error.message)) return "network";
  return "unknown";
}

const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_MAX_MS = 8_000;

/** Exponential retry delay with a small jitter so concurrent clients do not retry in lockstep.
 *  A server-provided Retry-After takes precedence (capped at 120s). */
export function modelRetryDelayMs(attempt: number, random = Math.random, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(120_000, retryAfterMs) + Math.floor(Math.max(0, Math.min(1, random())) * 250);
  }
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

/** Extracts a file path from the tool arguments, for Hook condition matching and env-var injection. */
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
    throw new ToolCallParseError(`invalid completed tool-call index: ${String(raw.index)}`);
  }
  if (!raw.name.trim()) throw new ToolCallParseError(`completed tool call ${raw.index} is missing a name`);
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(raw.argumentsJson);
  } catch (error) {
    throw new ToolCallParseError(
      `invalid arguments for completed tool call ${raw.index}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new ToolCallParseError(`invalid arguments for completed tool call ${raw.index}: expected an object`);
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
  // A shallow copy is enough: message objects are immutable once enqueued, so this only appends
  // a reminder without rewriting elements.
  const copy = [...messages];
  // Runtime reminders are appended at the end of the request (instead of before the conversation):
  // per-turn reminder text no longer breaks the byte-identity of the stable prefix
  // [system + conversation], letting DeepSeek/OpenAI prefix caching cover the whole conversation.
  if (reminders.length) copy.push(systemReminderMessage(reminders));
  return copy;
}

/**
 * Converts a model reply into an assistant message. Reasoning output is preserved too: DeepSeek
 * thinking mode requires reasoning_content to be sent back with the next request, and Anthropic
 * extended thinking requires replaying signed thinking blocks; both read their data from here.
 */
export function assistantMessage(response: ModelResponse): Message {
  return {
    role: "assistant",
    content: response.text,
    toolCalls: response.toolCalls,
    ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    ...(response.reasoningSignature ? { reasoningSignature: response.reasoningSignature } : {}),
  };
}

export function usageAnchorMessages(messages: readonly Message[], response: ModelResponse): Message[] {
  return [...messages, assistantMessage(response)];
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

export interface WorkspaceSnapshot {
  fingerprint: string;
  /** The `git status --porcelain` line list; empty when git is unavailable (no receipt info then). */
  entries: readonly string[];
}

/** Fetches the fingerprint and status lines in one pass: the execution receipt needs
 *  before/after line lists to compute a difference. */
export async function workspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  try {
    const result = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: WORKSPACE_FINGERPRINT_TIMEOUT_MS,
      windowsHide: true,
    });
    const entries = result.stdout.split(/\r?\n/).filter(Boolean).sort();
    return { fingerprint: `git:${entries.join("\n")}`, entries };
  } catch {
    return { fingerprint: await collectWorkspaceEntries(resolve(root)), entries: [] };
  }
}

export async function workspaceFingerprint(root: string): Promise<string> {
  return (await workspaceSnapshot(root)).fingerprint;
}

/** Status-line difference: added/changed lines are listed as-is, vanished lines get a `-` prefix. */
export function diffWorkspaceEntries(before: readonly string[], after: readonly string[]): readonly string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const changes: string[] = [];
  for (const entry of after) {
    if (!beforeSet.has(entry)) changes.push(entry);
  }
  for (const entry of before) {
    if (!afterSet.has(entry)) changes.push(`- ${entry}`);
  }
  return changes;
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
