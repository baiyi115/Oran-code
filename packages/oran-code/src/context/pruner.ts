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
 * offload 账本:跨轮冻结的替换文本、已见 id 与失败计数。
 * 由调用方(ContextManager)持有并跨轮复用,保证同一 id 只有一条终态替换文本。
 */
export interface PrunerLedger {
  readonly seenIds: Set<string>;
  readonly replacements: Map<string, string>;
  readonly offloadFailures: Map<string, number>;
}

/** 落盘回调:返回落盘相对路径,失败返回 undefined(调用方保留原文)。 */
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
 * 应用活跃上下文的工具结果上限。
 *
 * 两段策略,按阈值分层、互不重叠:
 * 1. microcompact(确定性、无 LLM):清空"早期且中等大小"工具结果的正文,
 *    只留字节数与读回路径——这些结果本不会触发 offload,长会话里会无限累积;
 * 2. offload(按单条/单轮预算):超限结果落盘并保留预览。
 *
 * 替换文本写入 ledger 冻结,保证同一 id 只有一条终态替换文本。
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
        // seen id 免于重复 offload;但历史轮的超限内容不受豁免,否则历史轮
        // 会随轮次推移永久超出预算。
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
 * 在一轮工具结果发布给 trace/UI/会话之前应用活跃上下文上限。
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
 * microcompact:清空"早期且足够大"的工具结果正文。
 *
 * - 只作用于最近 `microcompactKeepResults` 条之外的记录,当前轮与近期结果保持原文;
 * - 小于 `microcompactMinBytes` 的结果保持原样(清空小结果只丢信息、不省预算);
 * - 清空前先落盘,失败即保留原文,因此清空永远不造成不可恢复的信息丢失。
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
 * 压缩后保留的最近原文。
 * 预算 = max(recentRawTokens 下限, window × recentRawFraction);未提供窗口时用固定下限,
 * 保证既有调用方的行为不变。
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
    // 单个超大 unit(如带 50KB 工具输出)不该把整个 recent 预算吃光:
    // 在已保有至少一个单位且满足最小消息数时,丢弃这个超大单位。
    if (start < units.length - 1 && count >= CONTEXT_LIMITS.recentRawMessages && tokens + unitTokens > tokenBudget) {
      start += 1;
      break;
    }
    tokens += unitTokens;
    count += unit.length;
  }

  // 保证 recent 消息片段必须从合法的 user 轮开始:
  // 如果当前选取的起点落在了某个 turn 中途(如孤儿 assistant 工具调用或 tool 结果),
  // 绝不能直接作为压缩后非系统消息的开头(Gemini/Anthropic/OpenAI 均要求对话由 user 开启)。
  if (start < units.length && units[start]?.[0]?.role !== "user") {
    // 优先向后查找:若当前位置之后存在 user 消息,说明候选集越界拖入了更早 turn 的末尾片段;
    // 丢弃更早 turn 的孤儿单元,从最近一个合法的 user 轮开始保留。
    const forwardUserIndex = units.findIndex((unit, idx) => idx >= start && unit[0]?.role === "user");
    if (forwardUserIndex !== -1) {
      start = forwardUserIndex;
    } else {
      // 若向后没有 user 消息(说明整个候选区间处于同一个超长 turn 内部),
      // 向前倒推至开启当前 turn 的 user 消息,保证该 turn 的完整性与合法起始角色。
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
