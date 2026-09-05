/** Anthropic 与 OpenAI 兼容两条转换路径共享的收尾逻辑。 */

import type { ProviderRequestOptions } from "../types.js";

/** 非流式 complete() 的默认整体超时:挂起的端点不能无限占住压缩、标题、记忆等辅助调用。 */
export const DEFAULT_COMPLETE_TIMEOUT_MS = 300_000;

/**
 * 合并调用方 signal 与非流式整体超时。超时以 AbortSignal.timeout 实现,
 * fetch 会以 `TimeoutError` 而非 `AbortError` 拒绝,不会与用户取消混淆,
 * 因此上层重试逻辑可以把超时当作普通临时故障处理。
 */
export function completeRequestSignal(
  options?: ProviderRequestOptions,
  timeoutOverride?: unknown,
): AbortSignal | undefined {
  const configured =
    typeof timeoutOverride === "number" && Number.isFinite(timeoutOverride) && timeoutOverride > 0
      ? timeoutOverride
      : DEFAULT_COMPLETE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(configured);
  return options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/**
 * 运行时提醒统一合并到对话末尾的 user 消息上,避免逐轮变化的提醒文本
 * 就地改写历史消息而击穿稳定前缀缓存。没有 user 消息时追加一条。
 */
export function appendTailReminder(conversation: Array<Record<string, unknown>>, reminderText: string): void {
  if (!reminderText) return;
  const last = conversation[conversation.length - 1];
  if (last && last.role === "user") {
    if (typeof last.content === "string") {
      last.content = `${last.content}\n\n${reminderText}`;
    } else if (Array.isArray(last.content)) {
      last.content.push({ type: "text", text: reminderText });
    } else {
      conversation.push({ role: "user", content: reminderText });
    }
    return;
  }
  conversation.push({ role: "user", content: reminderText });
}
