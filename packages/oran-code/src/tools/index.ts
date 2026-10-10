import { relative, resolve } from "node:path";
import { projectStateRoot } from "../paths.js";
import { registerWorktreeTools } from "../worktree/tools.js";
import { resolveWorkspacePath } from "./fs-helpers.js";
import { registerReadTools } from "./read-tools.js";
import { registerWriteTools } from "./write-tools.js";
import { registerCommandTools, type CommandToolOptions } from "./command-tools.js";
import { registerWebTools } from "./web-tools.js";
import { registerBatchTools } from "./batch-tools.js";
import { registerPlanTools } from "./plan-tools.js";
import { registerSearchTools } from "./search-tools.js";
import { registerInteractionTools } from "./interaction-tools.js";
import { registerGraphTools } from "../graph/tools.js";
import type { ToolFactoryContext } from "./registry.js";
import { ToolRegistry } from "./registry.js";

export function registerBuiltinTools(
  registry: ToolRegistry,
  workspace: string,
  options: CommandToolOptions = {},
): void {
  const root = resolve(workspace);
  const planRoot = resolve(projectStateRoot(root), "plans");
  const ctx: ToolFactoryContext = {
    root,
    planDirectory: relative(root, planRoot).replaceAll("\\", "/"),
    activeRoot: (context) => (context?.workspace ? resolve(context.workspace) : root),
    pathFor: (context, raw) => resolveWorkspacePath(ctx.activeRoot(context), raw),
  };

  registerReadTools(registry, ctx);
  registerPlanTools(registry);
  registerBatchTools(registry);
  registerWriteTools(registry, ctx);
  registerCommandTools(registry, ctx, options);
  registerWebTools(registry, ctx);
  registerInteractionTools(registry, ctx);
  registerSearchTools(registry);
  registerWorktreeTools(registry, root);
  registerGraphTools(registry, ctx);
}

export { ToolRegistry };
export type { ToolFactoryContext };
