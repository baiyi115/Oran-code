/** Single mapping from tool name to short UI label, shared by work rows and transcript tool rows. */
export function toolDisplayName(name: string): string {
  switch (name) {
    case "read_file":
      return "Read";
    case "show_signature":
      return "Outline";
    case "write_file":
      return "Write";
    case "edit_file":
      return "Edit";
    case "apply_patch":
      return "Patch";
    case "run_command":
      return "Bash";
    case "glob_files":
      return "Glob";
    case "search_code":
      return "Search";
    case "list_files":
      return "List";
    case "git_status":
      return "GitStatus";
    case "get_diff":
      return "Diff";
    default:
      return name;
  }
}
