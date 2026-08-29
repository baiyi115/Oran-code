import type { ToolDefinition } from "../types.js";
import { WORKTREE_TOOL_NAMES } from "../worktree/tools.js";

/** 工具搜索别名表：与工具名单同一来源，供 search_tools 评分与精确解锁使用。 */
export const TOOL_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  list_files: ["ls", "dir", "directory", "folder", "browse", "列出", "目录"],
  read_file: ["cat", "view", "open", "read", "读取", "查看"],
  write_file: ["create", "save", "touch", "write", "创建", "写入"],
  write_plan: ["plan", "todo", "roadmap", "计划"],
  edit_file: ["replace", "modify", "change", "edit", "修改", "替换"],
  apply_patch: ["patch", "diff", "unified diff", "补丁"],
  glob_files: ["find", "locate", "file search", "glob", "查找文件", "文件搜索"],
  search_code: ["grep", "rg", "ripgrep", "search", "code search", "搜索代码", "文本搜索"],
  run_command: ["shell", "bash", "sh", "cmd", "powershell", "exec", "terminal", "command", "终端", "命令"],
};

export function isWriteToolName(name: string): boolean {
  return name === "apply_patch" || name === "write_file" || name === "edit_file" || name === "write_plan";
}

export function isMutatingToolName(name: string): boolean {
  return isWriteToolName(name) || name === "run_command" || WORKTREE_TOOL_NAMES.includes(name);
}

export function isPlanModeTool(tool: ToolDefinition): boolean {
  return tool.system === true || tool.kind === "readonly" || tool.name === "write_plan";
}
