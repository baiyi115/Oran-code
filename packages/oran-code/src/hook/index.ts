/** Public facade for the hook module. */
export type {
  HookAction,
  HookActionType,
  HookCondition,
  HookConditionClause,
  HookConditionLogic,
  HookConfig,
  HookEngineDeps,
  HookErrorPolicy,
  HookEvent,
  HookEventContext,
  HookDispatchResult,
  HookNotice,
  HookNoticeSink,
  HookOperator,
  HookResult,
  HookSubAgentExecutor,
  HookValidationError,
} from "./types.js";
export { HOOK_ACTION_TYPES, HOOK_EVENTS, HOOK_ERROR_POLICIES } from "./types.js";
export { HookEngine, type HookEngineOptions } from "./engine.js";
export { HookNoticeQueue } from "./notify-queue.js";
export {
  createHookEngine,
  createHookEngineDeps,
  extractHooks,
  loadAllHooks,
  type HooksConfigSlice,
} from "./config-loader.js";
export { parseCondition, evaluateCondition, isHookEvent } from "./condition.js";
