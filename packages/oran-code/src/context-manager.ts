/**
 * 上下文子系统的公开入口(facade)。
 *
 * 实现位于 context/ 目录,按职责拆分:
 * - limits.ts     — 预算阈值常量
 * - estimator.ts  — token 估算与上下文窗口解析
 * - pruner.ts     — 工具结果 offload / microcompact / 近期原文保留
 * - spill.ts      — 工具结果落盘与占位文本
 * - compaction.ts — LLM 压缩(摘要契约、恢复消息、触发编排)
 * - manager.ts    — ContextManager facade:跨轮状态与锁
 *
 * 外部调用方(turn-requester / tool-executor / session* / subagent)继续从这里导入。
 */
export { CONTEXT_LIMITS } from "./context/limits.js";
export { ContextManager } from "./context/manager.js";
export type { ContextManagerOptions } from "./context/manager.js";
export type {
  ContextOffloadResult,
  ToolResultOffloadCandidate,
  ToolResultOffloadResult,
} from "./context/pruner.js";
export type {
  ContextCompactionReason,
  ContextCompactOptions,
  ContextCompactResult,
} from "./context/compaction.js";
