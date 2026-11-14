/**
 * Central threshold definitions for context budgeting and spill.
 * Compaction, offload, recent-retention, and token estimation all share this one set of constants
 * so they cannot drift apart.
 */
export const CONTEXT_LIMITS = Object.freeze({
  singleToolResultBytes: 80_000,
  toolRoundBytes: 300_000,
  historicalToolResultBytes: 32_000,
  historicalToolRoundBytes: 96_000,
  /**
   * Space reserved for the summary when sizing a compaction request. Deliberately
   * conservative and much larger than what the model will actually emit (the usual
   * output cap is a few thousand tokens): over-reserving makes compaction fire
   * early, which is the safe direction, so this is a policy number rather than the
   * request's real ceiling.
   */
  summaryOutputTokens: 20_000,
  summaryMaxTokens: 8_192,
  summaryUserTokens: 8_000,
  recoveryFileTokens: 8_000,
  automaticSafetyTokens: 13_000,
  manualSafetyTokens: 3_000,
  recentRawTokens: 12_000,
  recentRawMessages: 5,
  /**
   * Fraction of the window kept as recent verbatim text after compaction: the larger of
   * window × this fraction and recentRawTokens.
   */
  recentRawFraction: 0.16,
  /**
   * Window-fraction ceiling for automatic compaction: with a large window it fires early at
   * window × 80% instead of compressing right at the limit.
   */
  automaticWindowFraction: 0.8,
  recentFileCount: 5,
  recentFileTokens: 8_000,
  automaticFailureLimit: 3,
  summaryDirectDrops: 3,
  summaryDropFraction: 0.2,
  /**
   * Maximum summarization attempts within a single compaction: a failed response is appended as
   * corrective feedback and retried.
   */
  summaryAttempts: 3,
  charactersPerToken: 3.5,
  /**
   * CJK characters estimated conservatively at 1 token/character (common Chinese tokenizers give
   * 1~1.5 characters/token).
   */
  cjkTokensPerCharacter: 1.0,
  previewBytes: 8_192,
  previewLines: 80,
  /**
   * microcompact: how many of the most recent tool results keep their verbatim text whatever the
   * budget below says.
   */
  microcompactKeepResults: 8,
  /**
   * microcompact: byte budget for the tool results older than the keep window. Oldest results are
   * cleared only while the older history exceeds it, so a short session keeps everything it just
   * read instead of losing evidence a couple of turns later and reading it again.
   */
  microcompactHistoricalBytes: 96_000,
  /**
   * microcompact: results smaller than this byte count are not worth clearing and keep their
   * verbatim text even when the budget is exceeded.
   */
  microcompactMinBytes: 4_000,
});

/** Fire at 80% for large windows, or earlier when summary output and safety headroom require it. */
export function automaticCompactionThreshold(contextWindow: number, outputTokens: number = CONTEXT_LIMITS.summaryOutputTokens): number {
  const headroom = contextWindow - Math.max(CONTEXT_LIMITS.summaryOutputTokens, outputTokens) - CONTEXT_LIMITS.automaticSafetyTokens;
  const windowBudget = Math.floor(contextWindow * CONTEXT_LIMITS.automaticWindowFraction);
  return Math.max(1, Math.min(windowBudget, headroom));
}

/** Input allowance shared by normal requests and post-compaction validation. */
export function requestInputLimit(contextWindow: number, outputTokens: number): number {
  if (!Number.isInteger(outputTokens) || outputTokens <= 0) throw new Error("maxTokens must be a positive integer");
  const limit = contextWindow - outputTokens - CONTEXT_LIMITS.manualSafetyTokens;
  if (limit <= 0) throw new Error("context window cannot fit the requested output limit and safety reserve");
  return limit;
}

/**
 * Retry ceiling for spilling a single tool result to disk: past it the result is let through,
 * avoiding a retry every turn while the disk keeps failing.
 */
export const MAX_OFFLOAD_FAILURES = 3;
