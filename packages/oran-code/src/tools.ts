/**
 * Thin barrel: tool implementations are split by family under ./tools/ (registry/predicates and
 * the individual tool families). The file keeps the same name so existing import paths stay
 * unchanged, including session.ts's dynamic import("./tools.js").
 */
export { ToolRegistry, registerBuiltinTools } from "./tools/index.js";
export type { ToolFactoryContext } from "./tools/registry.js";
export { atomicWriteFile } from "./tools/fs-helpers.js";
export { killProcessTree, formatPreservingTail } from "./tools/process.js";
export { isWriteToolName, isMutatingToolName, isPlanModeTool, TOOL_SEARCH_ALIASES } from "./tools/predicates.js";
