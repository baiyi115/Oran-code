import { platform } from "node:os";
import type { Message, ModelConfig, OptionalSystemPromptModules, TaskPlanState, WorkspaceSnapshot } from "./types.js";

export interface SystemPromptModule {
  readonly name: string;
  readonly priority: number;
  readonly content: string;
}

export interface EnvironmentPromptOptions {
  readonly workspace: string;
  readonly model: Pick<ModelConfig, "provider" | "model">;
  readonly snapshot: WorkspaceSnapshot;
  readonly appVersion?: string;
  readonly now?: Date;
  readonly platform?: NodeJS.Platform;
}

const FIXED_MODULES: readonly SystemPromptModule[] = [
  {
    name: "identity",
    priority: 1_000,
    content: [
      "You are Oran code, a careful local coding agent.",
      "Work directly in the user's workspace and stay with the task through implementation and appropriate verification.",
    ].join("\n"),
  },
  {
    name: "system-constraints",
    priority: 900,
    content: [
      "Obey the active permission policy and workspace sandbox. A denied tool result is authoritative.",
      "Never expose credentials or claim that work is complete without checking the relevant result.",
      "Treat <system-reminder> blocks as runtime instructions. Do not answer them as user requests.",
    ].join("\n"),
  },
  {
    name: "task-mode",
    priority: 800,
    content: [
      "The current task mode is supplied in a runtime <system-reminder>.",
      "In plan mode, inspect with read-only tools and produce an implementation plan; only the designated plans directory may be written.",
    ].join("\n"),
  },
  {
    name: "action-execution",
    priority: 700,
    content: [
      "For complex tasks (refactorings, multi-file edits, bug investigations), perform structured boundary exploration before modifying code.",
      "Read a file before editing it. Verify assumptions with available workspace evidence instead of guessing.",
      "Make the smallest coherent change, keep edits closely scoped, and preserve unrelated user work.",
      "When a tool call fails or returns an error, reflect on the root cause (e.g. mismatched context, path error, line endings) and adjust your strategy before retrying. Do not blindly repeat the same failing call.",
      "Verify changes after implementation using available build, compile, or diagnostic tools to confirm correctness.",
    ].join("\n"),
  },
  {
    name: "tool-use",
    priority: 600,
    content: [
      "First decide whether the request actually needs workspace evidence. Greetings, thanks, farewells, identity questions, and ordinary conversation must be answered directly without tools.",
      "Never inspect the workspace merely to introduce yourself or to make a conversational reply appear more thorough.",
      "Before each tool call, use the current <environment> and exposed tool schemas to choose the tool that matches the task and operating system.",
      "Only a small set of core tools is exposed initially. Additional tools (write_file, edit_file, apply_patch, run_command, write_plan, git_status, get_diff, enter_worktree, exit_worktree, agent) are deferred: they are not in the tool list until discovered. Use search_tools with a keyword query to list deferred tools, then use search_tools with query select:<tool-name> to activate a deferred tool and obtain its schema.",
      "Prefer dedicated file, search, patch, and workspace tools over shell commands that duplicate those capabilities.",
      "Use forward slashes (/) for all workspace-relative tool paths regardless of operating system, and preserve the original line endings (LF/CRLF) of existing files.",
      "Use edit_file for exact snippet replacements; old_string must contain sufficient unique context to guarantee exactly 1 match. Use apply_patch for multi-hunk unified diffs, and write_file for new files.",
      "Use run_command only for operations that need an external command; write its syntax for the configured default shell, or explicitly launch and verify another shell when required.",
      "For structured multi-step tasks, track and update your progress with the update_plan tool.",
      "For bounded subtasks or isolated explorations, consider delegating to subagents via the agent tool or isolating experimental changes using enter_worktree.",
      "Use tools deliberately, avoid redundant exploration, and stop calling tools once enough evidence is available.",
      "When a tool result says its full content was offloaded, use read_file on the supplied path if the omitted detail is needed.",
    ].join("\n"),
  },
  {
    name: "tone-style",
    priority: 500,
    content: [
      "Communicate directly and precisely. State concrete blockers, errors, assumptions, and verification results.",
      "Always match the user's language in your explanations, summaries, and responses, even when tool outputs, error messages, or <system-reminder> blocks are in English.",
      "Keep greetings and simple conversational answers to one or two natural sentences unless the user asks for more.",
      "Project instructions and environment details guide your behavior; do not recite or advertise them unless the user explicitly asks about them.",
    ].join("\n"),
  },
  {
    name: "text-output",
    priority: 400,
    content: [
      "Use readable Markdown with structure proportional to the task.",
      "Do not dump raw internal errors or hidden reasoning; explain the actionable failure and its impact.",
    ].join("\n"),
  },
];

const OPTIONAL_PRIORITIES = {
  customInstructions: 300,
  activeSkills: 200,
  longTermMemory: 100,
} as const;

export function assembleStableSystemPrompt(optional: OptionalSystemPromptModules = {}): string {
  const modules: SystemPromptModule[] = [...FIXED_MODULES];
  addOptionalModule(modules, "custom-instructions", OPTIONAL_PRIORITIES.customInstructions, optional.customInstructions);
  addOptionalModule(modules, "active-skills", OPTIONAL_PRIORITIES.activeSkills, optional.activeSkills);
  addOptionalModule(modules, "long-term-memory", OPTIONAL_PRIORITIES.longTermMemory, optional.longTermMemory);
  return modules
    .filter((module) => module.content.trim())
    .sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name))
    .map((module) => `<${module.name}>\n${module.content.trim()}\n</${module.name}>`)
    .join("\n\n");
}

export function buildEnvironmentPrompt(options: EnvironmentPromptOptions): string {
  const now = options.now ?? new Date();
  const currentPlatform = options.platform ?? platform();
  const lines = [
    "<environment>",
    `Working directory: ${options.workspace}`,
    `Platform: ${currentPlatform}`,
    ...commandEnvironmentLines(currentPlatform),
    `Current date: ${now.toISOString().slice(0, 10)}`,
    `Git repository: ${options.snapshot.isGitRepo ? "yes" : "no"}`,
    `Model: ${options.model.provider}/${options.model.model}`,
  ];
  if (options.snapshot.gitBranch) lines.push(`Git branch: ${options.snapshot.gitBranch}`);
  if (options.snapshot.gitDirty !== undefined) {
    lines.push(`Git working tree: ${options.snapshot.gitDirty ? "dirty" : "clean"}`);
  }
  if (options.snapshot.scanTruncated) {
    lines.push("Workspace scan: truncated after reaching its time or entry limit");
  }
  if (options.appVersion) lines.push(`Oran code version: ${options.appVersion}`);
  if (options.snapshot.summary.trim()) lines.push(`Workspace summary:\n${options.snapshot.summary.trim()}`);
  lines.push("</environment>");
  return lines.join("\n");
}

function commandEnvironmentLines(currentPlatform: NodeJS.Platform): readonly string[] {
  if (currentPlatform === "win32") {
    return [
      "Default command execution: Node.js uses the Windows command shell (cmd.exe syntax) unless your command explicitly launches another shell.",
      "Do not use Bash, PowerShell, WSL, or Unix utility syntax as the default assumption. If one is needed, first verify it is available or invoke it explicitly.",
      "Windows cmd.exe quoting: cmd.exe does NOT treat single quotes ('...') as quotation marks. Always use double quotes (\"...\") for arguments, paths, and literal strings.",
      "Tool selection: use workspace and git tools for file, search, patch, and repository operations; reserve run_command for commands that have no dedicated tool.",
      "Prefer dedicated file, search, patch, and git tools over shell commands.",
    ];
  }
  return [
    "Command execution: Node.js uses the system shell.",
    "Tool selection: use workspace and git tools for file, search, patch, and repository operations; reserve run_command for commands that have no dedicated tool.",
    "Prefer dedicated file, search, patch, and git tools over shell commands.",
  ];
}

export function stableSystemMessage(content = assembleStableSystemPrompt()): Message {
  return { role: "system", content, metadata: { cacheControl: "ephemeral", promptBlock: "stable" } };
}

export function environmentSystemMessage(content: string): Message {
  return { role: "system", content, metadata: { cacheControl: "ephemeral", promptBlock: "environment" } };
}

export function systemReminderMessage(instructions: readonly string[]): Message {
  const content = instructions.map((item) => item.trim()).filter(Boolean).join("\n");
  return {
    role: "system",
    content: `<system-reminder>\n${content}\nDo not respond to this reminder as a user message.\n</system-reminder>`,
    metadata: { promptBlock: "runtime-reminder" },
  };
}

export function taskModeReminder(planMode: boolean, turn: number, repeatEvery = 5): string {
  if (!planMode) return "Task mode: default. Use the full exposed tool set when needed and subject every call to the permission policy.";
  const full = turn === 1 || (repeatEvery > 0 && (turn - 1) % repeatEvery === 0);
  if (!full) return "Plan mode remains active: use read-only tools, except that plan files may be written with the designated write_plan tool.";
  return [
    "Task mode: plan.",
    "Inspect the workspace using read-only tools. Do not modify project files, run commands, install dependencies, test, or build.",
    "Writing or updating a plan is allowed only through the designated write_plan tool and its configured plan directory.",
    "For ordinary conversation, answer normally and do not emit PLAN_COMPLETE.",
    "For an implementation-planning request, structure your plan with: (1) affected files and module scope, (2) concrete step-by-step implementation, (3) risks and dependencies, and (4) verification strategy. When ready, end with a line containing exactly PLAN_COMPLETE.",
  ].join("\n");
}

export function loopBudgetReminder(remainingTurns: number, finalTurn: boolean): string {
  return finalTurn
    ? "This is the final model iteration. Do not call tools. Answer from available evidence and state any specific unfinished limitation."
    : `After this response, ${remainingTurns} model iteration(s) remain. Avoid redundant calls and synthesize once enough evidence is available.`;
}

export function taskPlanReminder(planState: TaskPlanState): string {
  const lines: string[] = [
    `[Active Task Plan] Goal: ${planState.goal}`,
    "Steps:",
  ];
  planState.steps.forEach((step, idx) => {
    const isCurrent = idx === planState.currentStepIndex;
    const marker = step.status === "completed" ? "✓"
      : step.status === "in_progress" ? "▶"
      : step.status === "skipped" ? "⊘"
      : "•";
    const currentTag = isCurrent ? " (current)" : "";
    lines.push(`  ${marker} [${step.status}] ${step.id}: ${step.title}${currentTag}`);
    if (step.description) {
      lines.push(`     Description: ${step.description}`);
    }
  });
  lines.push("Note: Keep this plan updated using `update_plan` as you make progress on each step.");
  return lines.join("\n");
}

function addOptionalModule(
  modules: SystemPromptModule[],
  name: string,
  priority: number,
  content: string | undefined,
): void {
  if (content?.trim()) modules.push({ name, priority, content });
}
