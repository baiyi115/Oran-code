/** Finalization logic shared by the Anthropic and OpenAI-compatible conversion paths. */

import type { ProviderRequestOptions } from "../types.js";

/**
 * Default overall timeout for non-streaming complete(): a hung endpoint must not occupy
 * auxiliary calls such as compaction, titles and memory extraction forever.
 */
export const DEFAULT_COMPLETE_TIMEOUT_MS = 300_000;

/**
 * Merge the caller's signal with the non-streaming overall timeout. The timeout is implemented
 * with AbortSignal.timeout, so fetch rejects with `TimeoutError` rather than `AbortError` and
 * cannot be confused with a user cancellation; the retry logic upstream can therefore treat a
 * timeout as an ordinary transient failure.
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
 * Runtime reminders are merged onto the trailing user message so that per-turn reminder text
 * does not rewrite history in place and break the stable prefix cache. When there is no user
 * message, one is appended.
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
