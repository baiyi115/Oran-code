/**
 * Wording shared by the TUI transcript and the plain-terminal renderer.
 *
 * Both surfaces report the same runtime events, and keeping a copy of each sentence in both places
 * is how "Context compacted (…)" and "Context compacted: …" drifted apart. These helpers own the
 * sentence; callers own the styling and the transport.
 */

/** Retry notice; the first line of the provider message is the part worth reading. */
export function retrySummary(nextAttempt: number, maxRetries: number, reason?: string): string {
  const detail = (reason ?? "").split(/\r?\n/)[0]?.trim() || "request failed";
  return `retrying (${nextAttempt}/${maxRetries}): ${detail}`;
}

export function compactionStartedSummary(reason: string): string {
  return reason === "emergency" ? "Context limit reached; compacting before retry..." : "Compacting context...";
}

export function compactionChangeSummary(beforeTokens?: number, afterTokens?: number): string {
  return beforeTokens !== undefined && afterTokens !== undefined
    ? `${beforeTokens} -> ${afterTokens} estimated tokens`
    : "token estimate unavailable";
}

export function compactionCompletedSummary(change: string, replacementCount = 0): string {
  const suffix = replacementCount > 0 ? `; offloaded ${replacementCount} tool result(s)` : "";
  return `Context compacted: ${change}${suffix}.`;
}

export function compactionFailedSummary(reason: string, message?: string): string {
  return `Context compaction failed (${reason}): ${message ?? "unknown compaction error"}`;
}

export function offloadedSummary(count: number): string {
  return `Offloaded ${count} large tool result(s) from active context.`;
}
