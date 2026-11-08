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
 * Appends runtime reminders as their own trailing user turn. Merging them into the previous user
 * message would rewrite that persisted message in every request, so the next turn could not reuse
 * the cached prefix up to it. Both the OpenAI-compatible and Anthropic APIs accept consecutive
 * user turns (Anthropic combines them server-side).
 */
export function appendTailReminder(conversation: Array<Record<string, unknown>>, reminderText: string): void {
  if (!reminderText) return;
  conversation.push({ role: "user", content: reminderText });
}
