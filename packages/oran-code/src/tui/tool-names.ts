/** 工具名到界面短标签的统一映射,工作行与 transcript 工具行共用。 */
export function toolDisplayName(name: string): string {
  switch (name) {
    case "read_file": return "Read";
    case "write_file": return "Write";
    case "edit_file": return "Edit";
    case "apply_patch": return "Write";
    case "apply_diff": return "Patch";
    case "run_command": return "Bash";
    case "glob_files": return "Glob";
    case "search_code": return "Search";
    case "list_files": return "List";
    case "git_status": return "GitStatus";
    case "get_diff": return "Diff";
    default: return name;
  }
}
