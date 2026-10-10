/**
 * Public entry point (facade) for the context subsystem.
 *
 * The implementation lives in context/ and is split by responsibility:
 * - limits.ts     — budget threshold constants
 * - estimator.ts  — token estimation and context-window resolution
 * - pruner.ts     — tool-result offload / microcompact / recent-verbatim retention
 * - spill.ts      — spilling tool results to disk and placeholder text
 * - compaction.ts — LLM compaction (summary contract, recovery message, trigger orchestration)
 * - manager.ts    — ContextManager facade: cross-turn state and locks
 *
 * External callers (turn-requester / tool-executor / session* / subagent) keep importing from here.
 */
export { CONTEXT_LIMITS } from "./context/limits.js";
export { ContextManager } from "./context/manager.js";
export type { ContextManagerOptions } from "./context/manager.js";
export type { ContextOffloadResult, ToolResultOffloadCandidate, ToolResultOffloadResult } from "./context/pruner.js";
export type { ContextCompactionReason, ContextCompactOptions, ContextCompactResult } from "./context/compaction.js";
