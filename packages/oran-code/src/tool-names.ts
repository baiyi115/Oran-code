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

/** Present-tense verb a running call reports; the activity half of a delegated task's row. */
const TOOL_ACTIVITY_VERBS: Readonly<Record<string, string>> = {
  read_file: "Reading",
  show_signature: "Outlining",
  write_file: "Writing",
  edit_file: "Editing",
  apply_patch: "Patching",
  run_command: "Running",
  glob_files: "Searching files",
  search_code: "Searching",
  list_files: "Listing",
  git_status: "Checking git status",
  get_diff: "Reading the diff",
  agent: "Delegating",
  team_spawn: "Spawning",
};

/** Argument keys that name what a call is working on, most specific first. */
const ACTIVITY_TARGET_KEYS = ["command", "path", "pattern", "glob", "description", "query", "url"] as const;

const ACTIVITY_MAX_CHARS = 80;

/**
 * One line describing what a running call is doing ("Reading src/session.ts", "Running git status").
 * The subagent panel shows this while a delegated task runs: a single `agent` tool row in the
 * parent transcript cannot say where the delegated work actually is.
 */
export function describeToolActivity(call: {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}): string {
  const verb = TOOL_ACTIVITY_VERBS[call.name] ?? `Using ${toolDisplayName(call.name)}`;
  const target = activityTarget(call.arguments);
  const text = target ? `${verb} ${target}` : verb;
  return text.length <= ACTIVITY_MAX_CHARS ? text : `${text.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;
}

function activityTarget(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ACTIVITY_TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return undefined;
}
