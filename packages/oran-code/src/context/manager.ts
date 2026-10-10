import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { cloneMessages } from "../message-utils.js";
import { projectStateRoot } from "../paths.js";
import type { Message, ModelConfig } from "../types.js";
import {
  buildRecoveryMessage as composeRecoveryMessage,
  compactConversation,
  isPromptTooLongError,
  type CompactionHost,
  type ContextCompactOptions,
  type ContextCompactResult,
  type RecoveryCoverage,
} from "./compaction.js";
import { estimatedRequestTokens, resolveContextWindow, usageTotal, type UsageAnchor } from "./estimator.js";
import { CONTEXT_LIMITS } from "./limits.js";
import {
  isStableRequestPrefix,
  offloadCandidates,
  offloadConversation,
  promptBlock,
  type ContextOffloadResult,
  type PrunerLedger,
  type ToolResultOffloadCandidate,
  type ToolResultOffloadResult,
} from "./pruner.js";
import { spillToolResult, isSafeToolCallId, type RecentFile, type SpillTarget } from "./spill.js";

const PROCESS_SESSION_ID = `${Math.floor(Date.now() / 1_000)}-${randomBytes(4).toString("hex")}`;
const PROCESS_CLAIMED_TOOL_CALL_IDS = new Set<string>();
let processNextToolCallId = 0;

export interface ContextManagerOptions {
  workspace: string;
  conversation?: readonly Message[];
}

/**
 * Layered context-management facade: owns the cross-turn state (ledger, usage anchor, recent
 * files, automatic-failure counter), while the actual responsibilities live in the context/
 * submodules — estimator (estimation), pruner (offload/microcompact), spill (disk spill),
 * compaction (LLM compaction).
 */
export class ContextManager {
  readonly processSessionId = PROCESS_SESSION_ID;
  private readonly workspace: string;
  private readonly stateDirectory: string;
  private readonly ledger: PrunerLedger = {
    seenIds: new Set<string>(),
    replacements: new Map<string, string>(),
    offloadFailures: new Map<string, number>(),
  };
  private readonly recentFiles = new Map<string, RecentFile>();
  private readonly archivedUserOccurrences = new Set<string>();
  private usageAnchor: UsageAnchor | undefined;
  private automaticFailures = 0;
  private ledgerTail: Promise<void> = Promise.resolve();
  private compactionTail: Promise<void> = Promise.resolve();
  private readonly compactionHost: CompactionHost;

  /** Budget notice level: warn only once when a level is crossed, reset to zero after compaction. */
  private usageNoticeLevel = 0;

  /**
   * Within one turn, several call sites estimate the same message batch over and over; serializing
   * the full JSON is costly, so memoize the most recent raw estimate keyed by element object
   * identity (messages are immutable once queued).
   */
  private estimateMemo: { messages: readonly Message[]; tools: unknown; tokens: number } | undefined;

  constructor(options: ContextManagerOptions) {
    this.workspace = resolve(options.workspace);
    this.stateDirectory = relative(this.workspace, projectStateRoot(this.workspace)).replaceAll("\\", "/");
    this.compactionHost = {
      estimateTokens: (messages, tools) => this.estimateTokens(messages, tools),
      archiveConversation: (messages) => this.archiveConversation(messages),
      offloadForEmergency: (messages) => this.offloadAndSnip(messages),
      buildRecoveryMessage: (tools, coverage) => this.buildRecoveryMessage(tools, coverage),
      resetUsageAnchor: () => this.resetUsageAnchor(),
      onAutomaticCompactionFailure: () => {
        this.automaticFailures += 1;
      },
      resetAutomaticFailures: () => {
        this.automaticFailures = 0;
      },
    };
    this.observeToolCallIds(options.conversation ?? []);
  }

  get autoCompactionDisabled(): boolean {
    return this.automaticFailures >= CONTEXT_LIMITS.automaticFailureLimit;
  }

  resolveContextWindow(model: ModelConfig): number {
    return resolveContextWindow(model);
  }

  /**
   * Context-usage visibility: the model has no sense of its remaining budget, so inject a reminder
   * when the compaction threshold is approaching, letting it wrap up on its own instead of being
   * compacted passively.
   */
  contextUsageReminder(model: ModelConfig, messages: readonly Message[]): string | undefined {
    const window = this.resolveContextWindow(model);
    if (window <= 0) return undefined;
    const estimate = this.estimateTokens(messages, []);
    const ratio = estimate / window;
    const level = ratio >= 0.8 ? 2 : ratio >= 0.6 ? 1 : 0;
    if (level === 0 || level <= this.usageNoticeLevel) return undefined;
    this.usageNoticeLevel = level;
    const percent = Math.min(99, Math.round(ratio * 100));
    return level === 2
      ? `Context usage is ~${percent}% of the model context window (est. ${estimate.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens). Finish the task or run /compact now; auto-compaction will trigger soon and older detail will be lost.`
      : `Context usage is ~${percent}% of the model context window (est. ${estimate.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens). Avoid redundant exploration and start converging on the final result.`;
  }

  isPromptTooLongError(error: unknown): boolean {
    return isPromptTooLongError(error);
  }

  claimToolCallId(preferred?: string): string {
    const candidate = preferred?.trim();
    if (candidate && isSafeToolCallId(candidate) && !PROCESS_CLAIMED_TOOL_CALL_IDS.has(candidate)) {
      PROCESS_CLAIMED_TOOL_CALL_IDS.add(candidate);
      return candidate;
    }
    let generated = `call_${processNextToolCallId++}`;
    while (PROCESS_CLAIMED_TOOL_CALL_IDS.has(generated)) generated = `call_${processNextToolCallId++}`;
    PROCESS_CLAIMED_TOOL_CALL_IDS.add(generated);
    return generated;
  }

  resetUsageAnchor(): void {
    this.usageAnchor = undefined;
    // Compaction is the one caller, and the level has to drop with the anchor: the
    // estimate falls after it, so the next climb through 60% or 80% is news again.
    // Without this the model was warned once per session at most, which is the
    // opposite of the point of the reminder.
    this.usageNoticeLevel = 0;
  }

  reset(): void {
    this.ledger.seenIds.clear();
    this.ledger.replacements.clear();
    this.ledger.offloadFailures.clear();
    this.recentFiles.clear();
    this.usageAnchor = undefined;
    this.estimateMemo = undefined;
    this.usageNoticeLevel = 0;
    this.automaticFailures = 0;
  }

  trackSuccessfulFileRead(path: string, content: string, readAt = new Date().toISOString()): void {
    const key = resolve(this.workspace, path).toLowerCase();
    this.recentFiles.set(key, { path, content, readAt });
  }

  recordUsage(
    usage: Record<string, number>,
    messages: readonly Message[],
    tools: readonly Record<string, unknown>[],
  ): void {
    const tokens = usageTotal(usage);
    if (tokens === undefined) return;
    this.usageAnchor = { tokens, contextEstimate: this.rawEstimate(messages, tools) };
  }

  private rawEstimate(messages: readonly Message[], tools: readonly Record<string, unknown>[]): number {
    const memo = this.estimateMemo;
    if (
      memo &&
      memo.tools === tools &&
      memo.messages.length === messages.length &&
      memo.messages.every((message, index) => message === messages[index])
    ) {
      return memo.tokens;
    }
    const tokens = estimatedRequestTokens(messages, tools);
    this.estimateMemo = { messages, tools, tokens };
    return tokens;
  }

  estimateTokens(messages: readonly Message[], tools: readonly Record<string, unknown>[] = []): number {
    if (!this.usageAnchor) return this.rawEstimate(messages, tools);
    const delta = this.rawEstimate(messages, tools) - this.usageAnchor.contextEstimate;
    return Math.max(0, Math.ceil(this.usageAnchor.tokens + delta));
  }

  refreshRecoveryMessage(messages: readonly Message[], tools: readonly Record<string, unknown>[]): Message[] {
    const hasRecovery = messages.some((message) => promptBlock(message) === "context-recovery");
    if (!hasRecovery) return cloneMessages(messages);
    const refreshed = cloneMessages(messages).filter((message) => promptBlock(message) !== "context-recovery");
    let insertionIndex = 0;
    for (const [index, message] of refreshed.entries()) {
      const block = promptBlock(message);
      if (isStableRequestPrefix(message) || block === "context-summary") insertionIndex = index + 1;
    }
    refreshed.splice(insertionIndex, 0, {
      role: "system",
      content: this.buildRecoveryMessage(tools),
      metadata: { promptBlock: "context-recovery", contextManaged: true },
    });
    return refreshed;
  }

  shouldAutoCompact(
    messages: readonly Message[],
    contextWindow: number,
    tools: readonly Record<string, unknown>[] = [],
  ): boolean {
    if (this.autoCompactionDisabled) return false;
    const threshold = contextWindow - CONTEXT_LIMITS.summaryOutputTokens - CONTEXT_LIMITS.automaticSafetyTokens;
    // With a large window, fire early at window × 80%: waiting until the limit means hitting the
    // ceiling during compaction, and compaction itself still sends a request. With a small window,
    // W−O−headroom is the real constraint.
    const windowBudget = Math.floor(contextWindow * CONTEXT_LIMITS.automaticWindowFraction);
    return this.estimateTokens(messages, tools) >= Math.max(1, Math.min(windowBudget, threshold));
  }

  async offloadAndSnip(messages: readonly Message[]): Promise<ContextOffloadResult> {
    return this.withLedgerLock(() => offloadConversation(this.ledger, messages, this.spillTool));
  }

  /**
   * Applies the active-context tool-result limits before callers publish a
   * completed tool round to the trace, UI, or conversation.
   */
  async offloadToolResults(candidates: readonly ToolResultOffloadCandidate[]): Promise<ToolResultOffloadResult> {
    return this.withLedgerLock(() => offloadCandidates(this.ledger, candidates, this.spillTool));
  }

  async compact(options: ContextCompactOptions): Promise<ContextCompactResult> {
    return this.withCompactionLock(() => compactConversation(this.compactionHost, options));
  }

  private readonly spillTool = (id: string, content: string): Promise<string | undefined> =>
    spillToolResult(this.spillTarget, id, content);

  private get spillTarget(): SpillTarget {
    return {
      workspace: this.workspace,
      stateDirectory: this.stateDirectory,
      processSessionId: this.processSessionId,
    };
  }

  private buildRecoveryMessage(tools: readonly Record<string, unknown>[], coverage?: RecoveryCoverage): string {
    return composeRecoveryMessage({
      recentFiles: this.recentFiles.values(),
      tools,
      manifestPath: this.userMessageManifestPath(),
      ...(coverage ? { coverage } : {}),
    });
  }

  private observeToolCallIds(messages: readonly Message[]): void {
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        if (call.id) PROCESS_CLAIMED_TOOL_CALL_IDS.add(call.id);
      }
      if (message.toolCallId) PROCESS_CLAIMED_TOOL_CALL_IDS.add(message.toolCallId);
    }
  }

  private async archiveConversation(messages: readonly Message[]): Promise<void> {
    const userLines: string[] = [];
    const occurrenceCounts = new Map<string, number>();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      if (message.role === "user") {
        const content = message.content ?? "";
        const digest = createHash("sha256").update(content, "utf8").digest("hex");
        const occurrence = occurrenceCounts.get(digest) ?? 0;
        occurrenceCounts.set(digest, occurrence + 1);
        const identity = `${digest}:${occurrence}`;
        if (this.archivedUserOccurrences.has(identity)) continue;
        this.archivedUserOccurrences.add(identity);
        userLines.push(JSON.stringify({ id: identity, content, archivedAt: new Date().toISOString() }));
      }
    }
    for (const message of messages) {
      if (message.role !== "tool" || !message.toolCallId) continue;
      await spillToolResult(this.spillTarget, message.toolCallId, message.content ?? "");
    }
    if (!userLines.length) return;
    try {
      const path = this.userMessageManifestPath();
      await mkdir(dirname(resolve(this.workspace, path)), { recursive: true });
      await appendFile(resolve(this.workspace, path), `${userLines.join("\n")}\n`, "utf8");
    } catch {
      // Archiving is best effort and must not interrupt compaction.
    }
  }

  private userMessageManifestPath(): string {
    return `${this.stateDirectory}/sessions/${this.processSessionId}/user-messages.jsonl`;
  }

  private async withLedgerLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.ledgerTail;
    let release = (): void => undefined;
    this.ledgerTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async withCompactionLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.compactionTail;
    let release = (): void => undefined;
    this.compactionTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
