/**
 * 薄 barrel：工具实现按族拆分在 ./tools/ 目录下（registry/predicates/各工具族）。
 * 保留同名文件以维持既有 import 路径（含 session.ts 的动态 import("./tools.js")）不变。
 */
export {
  ToolRegistry,
  registerBuiltinTools,
} from "./tools/index.js";
export type { ToolFactoryContext } from "./tools/registry.js";
export { atomicWriteFile } from "./tools/fs-helpers.js";
export {
  killProcessTree,
  formatPreservingTail,
} from "./tools/process.js";
export {
  isWriteToolName,
  isMutatingToolName,
  isPlanModeTool,
  TOOL_SEARCH_ALIASES,
} from "./tools/predicates.js";
