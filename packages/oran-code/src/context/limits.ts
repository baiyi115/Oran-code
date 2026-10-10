/**
 * 上下文预算与 spill 的集中阈值口径。
 * 压缩、offload、近期保留、token 估算共用这一份常量,避免各处漂移。
 */
export const CONTEXT_LIMITS = Object.freeze({
  singleToolResultBytes: 80_000,
  toolRoundBytes: 300_000,
  historicalToolResultBytes: 32_000,
  historicalToolRoundBytes: 96_000,
  summaryOutputTokens: 20_000,
  automaticSafetyTokens: 13_000,
  manualSafetyTokens: 3_000,
  recentRawTokens: 12_000,
  recentRawMessages: 5,
  /** 压缩后保留的最近原文比例:取 window × 该比例与 recentRawTokens 的较大者。 */
  recentRawFraction: 0.16,
  /** 自动压缩的窗口比例上限:大窗口下提前到 window × 80% 触发,而不是压到临界。 */
  automaticWindowFraction: 0.8,
  recentFileCount: 5,
  recentFileTokens: 8_000,
  automaticFailureLimit: 3,
  summaryDirectDrops: 3,
  summaryDropFraction: 0.2,
  /** 单轮压缩内摘要请求的最大尝试次数:失败响应会作为纠错反馈追加后重试。 */
  summaryAttempts: 3,
  charactersPerToken: 3.5,
  /** CJK 字符按 1 token/字 保守估算(常见中文 tokenizer 为 1~1.5 字/token)。 */
  cjkTokensPerCharacter: 1.0,
  previewBytes: 8_192,
  previewLines: 80,
  /** microcompact:保留最近多少条工具结果的原文,更早的清空正文(依然可落盘读回)。 */
  microcompactKeepResults: 8,
  /** microcompact:小于该字节数的历史结果不值得清空,保持原文。 */
  microcompactMinBytes: 4_000,
});

/** 单条工具结果的落盘失败重试上限:超过后放行,避免磁盘持续失败时每轮重试。 */
export const MAX_OFFLOAD_FAILURES = 3;
