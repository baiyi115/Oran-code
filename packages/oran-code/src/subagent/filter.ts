import type { ToolDefinition } from "../types.js";
import type { AgentDefinition } from "./types.js";

export const GLOBAL_SUBAGENT_DENIED_TOOLS = new Set([
  "agent",
  "task_stop",
  "task_cancel",
  "task_send",
  "task_retry",
  "ask_user",
  "request_user_input",
  "enter_plan_mode",
  "exit_plan_mode",
  "change_permission_mode",
  "team_create",
  "team_spawn",
  "team_send",
  "team_list",
  "team_delete",
  "team_resume",
]);

export const CUSTOM_SUBAGENT_DENIED_TOOLS = new Set(GLOBAL_SUBAGENT_DENIED_TOOLS);

export const BACKGROUND_SUBAGENT_ALLOWED_TOOLS = new Set([
  "list_files",
  "read_file",
  "write_file",
  "write_plan",
  "edit_file",
  "apply_patch",
  "apply_diff",
  "glob_files",
  "search_code",
  "run_command",
  "activate_skill",
  "search_tools",
  "enter_worktree",
  "exit_worktree",
]);

export interface SubagentToolFilterOptions {
  readonly definition?: AgentDefinition;
  readonly background: boolean;
  readonly customAgent: boolean;
  readonly customDeniedTools?: readonly string[];
  readonly isMcpTool: (name: string) => boolean;
  readonly parentFilter?: (tool: ToolDefinition) => boolean;
}

export function createSubagentToolFilter(options: SubagentToolFilterOptions): (tool: ToolDefinition) => boolean {
  const customDenied = new Set(options.customDeniedTools ?? []);
  const roleDenied = new Set(options.definition?.deniedTools ?? []);
  const roleAllowed = new Set(options.definition?.allowedTools ?? []);
  const wildcardOnly = roleAllowed.size === 1 && roleAllowed.has("*");
  return (tool) => {
    const name = tool.name;
    if (GLOBAL_SUBAGENT_DENIED_TOOLS.has(name)) return false;
    if (options.customAgent && CUSTOM_SUBAGENT_DENIED_TOOLS.has(name)) return false;
    if (customDenied.has(name)) return false;
    if (options.background && !BACKGROUND_SUBAGENT_ALLOWED_TOOLS.has(name)) return false;
    if (roleDenied.has(name)) return false;
    if (roleAllowed.size > 0 && !wildcardOnly && !roleAllowed.has(name)) return false;
    if (options.isMcpTool(name)) return true;
    return options.parentFilter?.(tool) ?? true;
  };
}
