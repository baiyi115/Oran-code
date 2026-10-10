import type { ToolDefinition } from "../types.js";
import { WORKTREE_TOOL_NAMES } from "../worktree/tools.js";

/** Tool search alias table: same source as the tool list, used by search_tools for scoring and exact activation. */
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
  job_output: ["background", "job", "async", "output", "后台", "作业", "输出"],
  job_kill: ["background", "job", "kill", "stop", "terminate", "后台", "作业", "停止"],
  web_fetch: ["fetch", "http", "url", "download", "page", "网页", "抓取"],
  web_search: ["search the web", "google", "internet", "web", "联网", "网络搜索"],
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
