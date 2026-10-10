import { cloneMessages } from "../message-utils.js";
import type { Message } from "../types.js";
import { estimatedRequestTokens } from "./estimator.js";
import { CONTEXT_LIMITS, MAX_OFFLOAD_FAILURES } from "./limits.js";
import { buildClearedReplacement, buildToolReplacement, isSafeToolCallId } from "./spill.js";

export interface ContextOffloadResult {
  messages: Message[];
  replacementCount: number;
  offloadedCount: number;
  failedCount: number;
}

export interface ToolResultOffloadCandidate {
  id: string;
  content: string;
}

export interface ToolResultOffloadResult {
  replacements: ReadonlyMap<string, string>;
  offloadedCount: number;
  failedCount: number;
}

/**
 * Offload ledger: replacement text frozen across turns, ids already seen, and failure counts.
 * Held by the caller (ContextManager) and reused across turns, guaranteeing that an id has only
 * one final replacement text.
 */
export interface PrunerLedger {
  readonly seenIds: Set<string>;
  readonly replacements: Map<string, string>;
  readonly offloadFailures: Map<string, number>;
}

/**
 * Spill callback: returns the relative path written to disk, or undefined on failure (the caller
 * then keeps the verbatim text).
 */
export type SpillToolResult = (id: string, content: string) => Promise<string | undefined>;

interface ToolCandidate {
  indices: number[];
  id: string;
  content: string;
  bytes: number;
  totalBytes: number;
}

export function promptBlock(message: Message): string | undefined {
  const value = message.metadata?.promptBlock;
  return typeof value === "string" ? value : undefined;
}

export function isStableRequestPrefix(message: Message): boolean {
  const block = promptBlock(message);
  return message.role === "system" && (block === "stable" || block === "environment");
}

export function isTransientRequestMessage(message: Message): boolean {
  const block = promptBlock(message);
  return isStableRequestPrefix(message) || block === "runtime-reminder" || block === "context-recovery";
}

/**
 * Applies the active-context tool-result limits.
 *
 * Two-stage strategy, layered by threshold and non-overlapping:
 * 1. microcompact (deterministic, no LLM): clear the body of "early and medium-sized" tool
 *    results, keeping only the byte count and the read-back path — these results would never
 *    trigger offload and would otherwise accumulate without bound in a long session;
 * 2. offload (per-result/per-round budget): over-limit results are spilled to disk with a
 *    preview kept.
 *
 * The replacement text is written to the ledger and frozen, guaranteeing that an id has only one
 * final replacement text.
 */
export async function offloadConversation(
  ledger: PrunerLedger,
  messages: readonly Message[],
  spill: SpillToolResult,
): Promise<ContextOffloadResult> {
  const copy = cloneMessages(messages);
  let replacementCount = 0;
  let offloadedCount = 0;
  let failedCount = 0;

  const microcompacted = await microcompactConversation(ledger, copy, spill);
  replacementCount += microcompacted.cleared;
  offloadedCount += microcompacted.cleared;

  for (let start = 0; start < copy.length;) {
    if (copy[start]?.role !== "tool") {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < copy.length && copy[end]?.role === "tool") end += 1;
    const isHistoricalRound = end < copy.length;

    const candidatesById = new Map<string, ToolCandidate>();
    let retainedBytes = 0;
    for (let index = start; index < end; index += 1) {
      const message = copy[index]!;
      const content = message.content ?? "";
      const bytes = Buffer.byteLength(content, "utf8");
      const id = message.toolCallId;
      if (!id) {
        retainedBytes += bytes;
        continue;
      }
      const frozenReplacement = ledger.replacements.get(id);
      if (frozenReplacement !== undefined) {
        if (message.content !== frozenReplacement) {
          message.content = frozenReplacement;
          replacementCount += 1;
        }
        continue;
      }
      if (ledger.seenIds.has(id) && (!isHistoricalRound || bytes <= CONTEXT_LIMITS.historicalToolResultBytes)) {
        // A seen id is exempt from repeated offload; over-limit content from historical rounds is
        // not, otherwise those rounds would stay permanently over budget as turns go by.
        retainedBytes += bytes;
        continue;
      }
      retainedBytes += bytes;
      const existing = candidatesById.get(id);
      if (existing) {
        existing.indices.push(index);
        existing.totalBytes += bytes;
      } else {
        candidatesById.set(id, { indices: [index], id, content, bytes, totalBytes: bytes });
      }
    }

    const maxSingleBytes = isHistoricalRound
      ? CONTEXT_LIMITS.historicalToolResultBytes
      : CONTEXT_LIMITS.singleToolResultBytes;
    const maxRoundBytes = isHistoricalRound ? CONTEXT_LIMITS.historicalToolRoundBytes : CONTEXT_LIMITS.toolRoundBytes;

    const candidates = [...candidatesById.values()].sort(
      (left, right) => right.bytes - left.bytes || left.indices[0]! - right.indices[0]!,
    );
    const attempted = new Set<string>();
    const canAttempt = (candidate: ToolCandidate): boolean =>
      (ledger.offloadFailures.get(candidate.id) ?? 0) < MAX_OFFLOAD_FAILURES;
    const replace = async (candidate: ToolCandidate): Promise<void> => {
      attempted.add(candidate.id);
      const relativePath = await spill(candidate.id, candidate.content);
      if (relativePath === undefined) {
        ledger.offloadFailures.set(candidate.id, (ledger.offloadFailures.get(candidate.id) ?? 0) + 1);
        failedCount += 1;
        return;
      }
      const replacement = buildToolReplacement(candidate.content, candidate.bytes, relativePath);
      ledger.offloadFailures.delete(candidate.id);
      for (const index of candidate.indices) copy[index]!.content = replacement;
      retainedBytes -= candidate.totalBytes;
      replacementCount += candidate.indices.length;
      offloadedCount += 1;
      ledger.replacements.set(candidate.id, replacement);
      ledger.seenIds.add(candidate.id);
    };

    for (const candidate of candidates) {
      if (candidate.bytes > maxSingleBytes && canAttempt(candidate)) await replace(candidate);
    }
    for (const candidate of candidates) {
      if (retainedBytes <= maxRoundBytes) break;
      if (!attempted.has(candidate.id) && canAttempt(candidate)) await replace(candidate);
    }
    for (const candidate of candidates) {
      if (!attempted.has(candidate.id)) ledger.seenIds.add(candidate.id);
    }
    start = end;
  }

  return { messages: copy, replacementCount, offloadedCount, failedCount };
}

/**
 * Applies the active-context limits before a round of tool results is published to the trace, UI,
 * or conversation.
 */
export async function offloadCandidates(
  ledger: PrunerLedger,
  candidates: readonly ToolResultOffloadCandidate[],
  spill: SpillToolResult,
): Promise<ToolResultOffloadResult> {
  const replacements = new Map<string, string>();
  const unique = new Map<string, ToolCandidate>();
  let retainedBytes = 0;

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.content || !isSafeToolCallId(candidate.id)) continue;
    const frozenReplacement = ledger.replacements.get(candidate.id);
    if (frozenReplacement !== undefined) {
      replacements.set(candidate.id, frozenReplacement);
      continue;
    }
    const bytes = Buffer.byteLength(candidate.content, "utf8");
    const existing = unique.get(candidate.id);
    if (existing) {
      existing.indices.push(index);
      existing.totalBytes += bytes;
    } else {
      unique.set(candidate.id, {
        indices: [index],
        id: candidate.id,
        content: candidate.content,
        bytes,
        totalBytes: bytes,
      });
    }
    retainedBytes += bytes;
  }

  const ordered = [...unique.values()].sort(
    (left, right) => right.bytes - left.bytes || left.indices[0]! - right.indices[0]!,
  );
  const attempted = new Set<string>();
  let offloadedCount = 0;
  let failedCount = 0;
  const replace = async (candidate: ToolCandidate): Promise<void> => {
    attempted.add(candidate.id);
    const relativePath = await spill(candidate.id, candidate.content);
    if (relativePath === undefined) {
      failedCount += 1;
      return;
    }
    const replacement = buildToolReplacement(candidate.content, candidate.bytes, relativePath);
    replacements.set(candidate.id, replacement);
    ledger.replacements.set(candidate.id, replacement);
    ledger.seenIds.add(candidate.id);
    retainedBytes -= candidate.totalBytes;
    offloadedCount += 1;
  };

  for (const candidate of ordered) {
    if (candidate.bytes > CONTEXT_LIMITS.singleToolResultBytes) await replace(candidate);
  }
  for (const candidate of ordered) {
    if (retainedBytes <= CONTEXT_LIMITS.toolRoundBytes) break;
    if (!attempted.has(candidate.id)) await replace(candidate);
  }
  for (const candidate of ordered) {
    if (!attempted.has(candidate.id)) ledger.seenIds.add(candidate.id);
  }

  return { replacements, offloadedCount, failedCount };
}

/**
 * microcompact: clear the body of "early and large enough" tool results.
 *
 * - Only touches records older than the most recent `microcompactKeepResults`; the current round
 *   and recent results keep their verbatim text;
 * - Results smaller than `microcompactMinBytes` are left as-is (clearing a small result only loses
 *   information without saving budget);
 * - Content is spilled to disk before being cleared, and a failed spill keeps the verbatim text,
 *   so clearing never causes unrecoverable information loss.
 */
async function microcompactConversation(
  ledger: PrunerLedger,
  messages: Message[],
  spill: SpillToolResult,
): Promise<{ cleared: number }> {
  const toolIndices: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool" && message.toolCallId) toolIndices.push(index);
  }
  const keepFrom = Math.max(0, toolIndices.length - CONTEXT_LIMITS.microcompactKeepResults);
  let cleared = 0;
  for (const index of toolIndices.slice(0, keepFrom)) {
    const message = messages[index]!;
    const id = message.toolCallId!;
    if (ledger.replacements.has(id)) continue;
    const content = message.content ?? "";
    if (content.startsWith("<offloaded-tool-result>") || content.startsWith("<cleared-tool-result>")) continue;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes < CONTEXT_LIMITS.microcompactMinBytes) continue;
    const relativePath = await spill(id, content);
    if (relativePath === undefined) continue;
    const replacement = buildClearedReplacement(bytes, relativePath);
    message.content = replacement;
    ledger.replacements.set(id, replacement);
    cleared += 1;
  }
  return { cleared };
}

function isCompleteToolUnit(unit: Message[]): boolean {
  const calls = unit[0]?.toolCalls ?? [];
  if (calls.some((call) => !call.id)) return false;
  const ids = new Set(calls.map((call) => call.id as string));
  for (const message of unit.slice(1)) {
    if (message.role === "tool" && message.toolCallId) ids.delete(message.toolCallId);
  }
  return ids.size === 0;
}

/**
 * Recent verbatim text retained after compaction.
 * Budget = max(the recentRawTokens floor, window × recentRawFraction); when no window is given the
 * fixed floor applies, keeping the behaviour of existing callers unchanged.
 */
export function selectRecentRawMessages(messages: readonly Message[], contextWindow?: number): Message[] {
  const rawMessages = messages.filter((message) => promptBlock(message) !== "context-summary");
  const tokenBudget =
    contextWindow !== undefined && contextWindow > 0
      ? Math.max(CONTEXT_LIMITS.recentRawTokens, Math.floor(contextWindow * CONTEXT_LIMITS.recentRawFraction))
      : CONTEXT_LIMITS.recentRawTokens;
  const units: Message[][] = [];
  for (let index = 0; index < rawMessages.length;) {
    const message = rawMessages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      const unit = [message];
      let next = index + 1;
      while (next < rawMessages.length && rawMessages[next]?.role === "tool") {
        unit.push(rawMessages[next]!);
        next += 1;
      }
      if (isCompleteToolUnit(unit)) units.push(unit);
      index = next;
      continue;
    }
    units.push([message]);
    index += 1;
  }

  let tokens = 0;
  let count = 0;
  let start = units.length;
  while (start > 0 && (tokens < tokenBudget || count < CONTEXT_LIMITS.recentRawMessages)) {
    start -= 1;
    const unit = units[start]!;
    const unitTokens = estimatedRequestTokens(unit, []);
    // A single oversized unit (say one carrying 50KB of tool output) should not eat the whole
    // recent budget: once at least one unit is retained and the minimum message count is met,
    // discard this oversized unit.
    if (start < units.length - 1 && count >= CONTEXT_LIMITS.recentRawMessages && tokens + unitTokens > tokenBudget) {
      start += 1;
      break;
    }
    tokens += unitTokens;
    count += unit.length;
  }

  // The recent slice must start at a legitimate user turn: if the chosen start lands mid-turn (an
  // orphaned assistant tool call or tool result, say), it must never become the head of the
  // post-compaction non-system messages (Gemini/Anthropic/OpenAI all require the conversation to be
  // opened by user).
  if (start < units.length && units[start]?.[0]?.role !== "user") {
    // Search forward first: if a user message exists after the current position, the candidate set
    // overreached and pulled in the tail of an earlier turn; drop that earlier turn's orphaned units
    // and retain from the nearest legitimate user turn.
    const forwardUserIndex = units.findIndex((unit, idx) => idx >= start && unit[0]?.role === "user");
    if (forwardUserIndex !== -1) {
      start = forwardUserIndex;
    } else {
      // If there is no user message further on (meaning the whole candidate range sits inside one
      // very long turn), walk backwards to the user message that opened the current turn, keeping
      // that turn whole and starting on a legitimate role.
      let backwardUserIndex = -1;
      for (let i = start - 1; i >= 0; i--) {
        if (units[i]?.[0]?.role === "user") {
          backwardUserIndex = i;
          break;
        }
      }
      if (backwardUserIndex !== -1) {
        start = backwardUserIndex;
      }
    }
  }

  return cloneMessages(units.slice(start).flat());
}
