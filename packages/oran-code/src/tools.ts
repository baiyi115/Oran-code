import { exec, execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskPlanStep, ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";
import { projectStateRoot, PROJECT_STATE_DIR_NAMES } from "./paths.js";
import { applyUnifiedDiff } from "./patch.js";
import { registerWorktreeTools } from "./worktree/tools.js";
import { isAbortError } from "./utils/abort-error.js";
import { isWithinPath, resolvePhysicalPath, resolveWithinRoot } from "./utils/path-containment.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  ...PROJECT_STATE_DIR_NAMES,
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 200;
/** 灾难性回溯需要长输入;超长行只匹配前缀。 */
const SEARCH_MAX_LINE_LENGTH = 4_096;
/** 搜索总时间预算,超时返回部分结果。 */
const SEARCH_TIME_BUDGET_MS = 2_000;

const TOOL_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
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

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly activated = new Set<string>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Deferred tools are hidden until explicitly activated via search_tools. */
  isDeferred(tool: ToolDefinition): boolean {
    return tool.deferred === true;
  }

  isExposed(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    return !this.isDeferred(tool) || this.activated.has(name);
  }

  /** Unlock a deferred tool by name. Returns undefined when the name is unknown or not deferred. */
  activate(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool || !this.isDeferred(tool)) return undefined;
    this.activated.add(name);
    return tool;
  }

  /** Unlock all deferred tools (used by tests or privileged runners). */
  activateAll(): void {
    for (const tool of this.tools.values()) {
      this.activated.add(tool.name);
    }
  }

  listExposed(): ToolDefinition[] {
    return [...this.tools.values()].filter((tool) => this.isExposed(tool.name));
  }

  schemas(filter?: (tool: ToolDefinition) => boolean): Record<string, unknown>[] {
    const all = [...this.tools.values()].filter((tool) => this.isExposed(tool.name));
    const tools = filter ? all.filter(filter) : all;
    return tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  async invoke(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.get(call.name);
    if (this.isDeferred(tool) && !this.activated.has(call.name) && context?.bypassActivation !== true) {
      return { ok: false, output: "", error: `tool is not activated: ${call.name}; discover it with search_tools first`, summary: "not activated" };
    }
    return tool.invoke(call, context);
  }
}

export function registerBuiltinTools(registry: ToolRegistry, workspace: string): void {
  const root = resolve(workspace);
  const planRoot = resolve(projectStateRoot(root), "plans");
  const planDirectory = relative(root, planRoot).replaceAll("\\", "/");
  const pathSchema = {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to workspace root." } },
    required: ["path"],
  };

  const activeRoot = (context?: ToolExecutionContext): string => context?.workspace ? resolve(context.workspace) : root;
  const pathFor = (context: ToolExecutionContext | undefined, raw: unknown): string => resolveWorkspacePath(activeRoot(context), raw);

  const register = (tool: ToolDefinition): void => {
    registry.register(tool);
  };

  register({
    name: "list_files",
    description: "List entries in a workspace directory.",
    parameters: pathSchema,
    permissionLevel: 0,
    kind: "readonly",
    maxOutputChars: 16_000,
    invoke: async (call, context) => {
      try {
        const workspace = activeRoot(context);
        const dir = pathFor(context, call.arguments.path ?? ".");
        const info = await stat(dir);
        if (!info.isDirectory()) {
          return { ok: false, output: "", error: `not a directory: ${displayPath(workspace, dir)}`, summary: "not a directory" };
        }
        const entries = await readdir(dir, { withFileTypes: true });
        return {
          ok: true,
          output: entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((item) => `${item.name}${item.isDirectory() ? "/" : ""}`)
            .join("\n"),
          summary: `${entries.length} entries`,
        };
      } catch (error) {
        return failedResult(error, "list_files failed");
      }
    },
  });

  register({
    name: "update_plan",
    description:
      "Update the structured task plan state machine. Use this tool to organize goals into discrete steps, track status ('pending' | 'in_progress' | 'completed' | 'skipped'), and ensure uninterrupted progress across session resumes and compaction.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The overarching goal of the task." },
        steps: {
          type: "array",
          description: "Ordered list of steps to accomplish the goal.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique step ID, e.g. 'step-1'." },
              title: { type: "string", description: "Concise title of the step." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "skipped"],
                description: "Execution status of the step.",
              },
              description: { type: "string", description: "Optional detailed explanation of this step." },
            },
            required: ["id", "title", "status"],
          },
        },
        currentStepIndex: {
          type: "number",
          description: "0-based index of the currently active or next pending step.",
        },
      },
      required: ["goal", "steps"],
    },
    permissionLevel: 0,
    system: true,
    kind: "readonly",
    maxOutputChars: 16_000,
    invoke: async (call) => {
      const goal = typeof call.arguments.goal === "string" ? call.arguments.goal.trim() : "";
      const rawSteps = Array.isArray(call.arguments.steps) ? call.arguments.steps : [];
      const steps: TaskPlanStep[] = rawSteps.map((s, idx) => {
        const item = (s && typeof s === "object") ? s as Record<string, unknown> : {};
        const rawStatus = typeof item.status === "string" ? item.status : "pending";
        const status = (rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "skipped") ? rawStatus : "pending";
        return {
          id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `step-${idx + 1}`,
          title: typeof item.title === "string" ? item.title.trim() : `Step ${idx + 1}`,
          status,
          ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {}),
        };
      });
      const currentStepIndex = typeof call.arguments.currentStepIndex === "number" && Number.isFinite(call.arguments.currentStepIndex)
        ? Math.max(0, Math.min(call.arguments.currentStepIndex, Math.max(0, steps.length - 1)))
        : Math.max(0, steps.findIndex((s) => s.status === "in_progress" || s.status === "pending"));

      const completedCount = steps.filter((s) => s.status === "completed").length;
      return {
        ok: true,
        output: JSON.stringify({ goal, steps, currentStepIndex }, null, 2),
        summary: `Task plan updated: ${completedCount}/${steps.length} steps completed`,
      };
    },
  });

  register({
    name: "read_file",
    description: "Read a UTF-8 text file with optional 1-based start line offset and line limit. Output includes line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        offset: { type: "integer", description: "1-based start line. Defaults to 1.", default: 1 },
        limit: { type: "integer", description: "Maximum number of lines to return. Defaults to 200.", default: DEFAULT_READ_LIMIT },
      },
      required: ["path"],
    },
    permissionLevel: 0,
    kind: "readonly",
    maxOutputChars: 32_000,
    invoke: async (call, context) => {
      try {
        const workspace = activeRoot(context);
        const path = pathFor(context, call.arguments.path);
        const info = await stat(path);
        if (info.isDirectory()) {
          return { ok: false, output: "", error: `path is a directory: ${displayPath(workspace, path)}`, summary: "is directory" };
        }
        const content = await readFile(path, "utf8");
        const lines = content.split(/\r?\n/);
        const offset = Math.max(1, intArg(call.arguments.offset, 1));
        const limit = Math.max(1, intArg(call.arguments.limit, DEFAULT_READ_LIMIT));
        const startIndex = offset - 1;
        if (startIndex >= lines.length) {
          return {
            ok: false,
            output: "",
            error: `offset ${offset} is beyond end of file (${lines.length} lines)`,
            summary: "offset out of range",
          };
        }
        const slice = lines.slice(startIndex, startIndex + limit);
        const width = String(startIndex + slice.length).length;
        const numbered = slice.map((line, index) => {
          const lineNo = String(startIndex + index + 1).padStart(width, " ");
          return `${lineNo}|${line}`;
        });
        const remaining = lines.length - (startIndex + slice.length);
        if (remaining > 0) numbered.push(`...[${remaining} more lines]`);
        return {
          ok: true,
          output: numbered.join("\n"),
          summary: `${lines.length} lines, showing ${slice.length} from L${offset}`,
        };
      } catch (error) {
        return failedResult(error, "read_file failed");
      }
    },
  });

  register({
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file inside the workspace. Read an existing target before overwriting it. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        content: { type: "string", description: "Full file content to write." },
      },
     required: ["path", "content"],
   },
   permissionLevel: 2,
   kind: "write",
   maxOutputChars: 16_000,
    deferred: true,
   invoke: async (call, context) => writeTextFile(activeRoot(context), (raw) => pathFor(context, raw), call.arguments.path, call.arguments.content),
 });

  register({
    name: "write_plan",
    description:
      `Create or overwrite a UTF-8 plan file. The path must be workspace-relative and strictly inside ${planDirectory}. This is the only write tool exposed in plan mode.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: `Workspace-relative path inside ${planDirectory}.` },
        content: { type: "string", description: "Full plan content to write." },
      },
     required: ["path", "content"],
   },
   permissionLevel: 2,
   kind: "write",
   maxOutputChars: 16_000,
    deferred: true,
   invoke: async (call, context) => writePlanFile(activeRoot(context), call.arguments.path, call.arguments.content),
 });

  register({
    name: "edit_file",
    description:
      "Replace text in an existing file after reading it. By default the old_string must match exactly once; set replace_all=true to replace every match. Returns a clear error when match count is 0 or >1.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        old_string: { type: "string", description: "Exact text to find." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every match instead of requiring a unique match.", default: false },
      },
     required: ["path", "old_string", "new_string"],
   },
   permissionLevel: 2,
   kind: "write",
   maxOutputChars: 16_000,
    deferred: true,
   invoke: async (call, context) => {
      try {
        const workspace = activeRoot(context);
        const path = pathFor(context, call.arguments.path);
        const info = await stat(path);
        if (info.isDirectory()) {
          return { ok: false, output: "", error: `path is a directory: ${displayPath(workspace, path)}`, summary: "is directory" };
        }
        const oldString = String(call.arguments.old_string ?? "");
        const newString = String(call.arguments.new_string ?? "");
        if (!oldString) {
          return { ok: false, output: "", error: "old_string must not be empty", summary: "invalid arguments" };
        }
        const content = await readFile(path, "utf8");
        const matches = countOccurrences(content, oldString);
        const replaceAll = call.arguments.replace_all === true;
        const isCrlf = content.includes("\r\n");
        const normalizedContent = content.replace(/\r\n/g, "\n");
        const normalizedOld = oldString.replace(/\r\n/g, "\n");
        const normalizedNew = newString.replace(/\r\n/g, "\n");
        const normalizedMatches = countOccurrences(normalizedContent, normalizedOld);

        if (matches === 0 && normalizedMatches > 0) {
          if (!replaceAll && normalizedMatches > 1) {
            return {
              ok: false,
              output: "",
              error: `old_string matched ${normalizedMatches} times in ${displayPath(workspace, path)}; refine the snippet or set replace_all=true`,
              summary: `${normalizedMatches} matches`,
              metadata: { matches: normalizedMatches },
            };
          }
          const nextNormalized = replaceAll
            ? normalizedContent.split(normalizedOld).join(normalizedNew)
            : normalizedContent.replace(normalizedOld, normalizedNew);
          const next = isCrlf ? nextNormalized.replace(/\n/g, "\r\n") : nextNormalized;
          await atomicWriteFile(path, next);
          const replaced = replaceAll ? normalizedMatches : 1;
          return {
            ok: true,
            output: `edited ${displayPath(workspace, path)} (${replaced} replacement${replaced === 1 ? "" : "s"})`,
            summary: replaceAll ? `replace_all ${replaced}` : "unique replace",
            metadata: { matches: replaced, replaceAll },
          };
        }

        if (matches === 0) {
          return {
            ok: false,
            output: "",
            error: `old_string matched 0 times in ${displayPath(workspace, path)}; provide a unique exact snippet`,
            summary: "0 matches",
            metadata: { matches: 0 },
          };
        }
        if (!replaceAll && matches > 1) {
          return {
            ok: false,
            output: "",
            error: `old_string matched ${matches} times in ${displayPath(workspace, path)}; refine the snippet or set replace_all=true`,
            summary: `${matches} matches`,
            metadata: { matches },
          };
        }
        const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
        await atomicWriteFile(path, next);
        const replaced = replaceAll ? matches : 1;
        return {
          ok: true,
          output: `edited ${displayPath(workspace, path)} (${replaced} replacement${replaced === 1 ? "" : "s"})`,
          summary: replaceAll ? `replace_all ${replaced}` : "unique replace",
          metadata: { matches: replaced, replaceAll },
        };
      } catch (error) {
        return failedResult(error, "edit_file failed");
      }
    },
  });

  register({
    name: "apply_patch",
    description:
      "Apply a unified diff to an existing UTF-8 text file. The diff must contain one or more @@ hunks; file header lines (index/---/+++) are ignored and the target comes from the path argument. Hunk line numbers may be approximate: each hunk is located by matching its context lines against the file. Returns the number of hunks applied and a summary of added/removed lines.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        diff: { type: "string", description: "Unified diff text with @@ hunks." },
      },
      required: ["path", "diff"],
    },
    permissionLevel: 2,
    kind: "write",
    maxOutputChars: 16_000,
    deferred: true,
    invoke: async (call, context) => {
      try {
        const workspace = activeRoot(context);
        const path = pathFor(context, call.arguments.path);
        const info = await stat(path);
        if (info.isDirectory()) {
          return { ok: false, output: "", error: `path is a directory: ${displayPath(workspace, path)}`, summary: "is directory" };
        }
        const diff = String(call.arguments.diff ?? "");
        if (!diff.trim()) {
          return { ok: false, output: "", error: "diff must not be empty", summary: "invalid arguments" };
        }
        const content = await readFile(path, "utf8");
        const applied = applyUnifiedDiff(content, diff);
        if (!applied.ok || applied.content === undefined) {
          return {
            ok: false,
            output: "",
            error: `apply_patch failed: ${applied.error ?? "unknown error"}`,
            summary: "patch failed",
          };
        }
        await atomicWriteFile(path, applied.content);
        return {
          ok: true,
          output: `applied ${applied.hunksApplied} hunk(s) to ${displayPath(workspace, path)} (+${applied.linesAdded}/-${applied.linesRemoved})`,
          summary: `applied ${applied.hunksApplied} hunks`,
          metadata: { hunksApplied: applied.hunksApplied, linesAdded: applied.linesAdded, linesRemoved: applied.linesRemoved },
        };
      } catch (error) {
        return failedResult(error, "apply_patch failed");
      }
    },
  });

  register({
    name: "glob_files",
    description:
      "Find files by glob pattern under the workspace (supports *, **, ?, and brace alternatives such as *.{ts,tsx}). Ignores VCS/dependency/build directories. Results are sorted by newest mtime first and capped.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts or src/**/*.md" },
        path: { type: "string", description: "Optional search root relative to workspace. Defaults to .", default: "." },
        limit: { type: "integer", description: "Maximum paths to return. Defaults to 200.", default: DEFAULT_GLOB_LIMIT },
      },
      required: ["pattern"],
    },
    permissionLevel: 0,
    kind: "readonly",
    maxOutputChars: 32_000,
    invoke: async (call, context) => {
      try {
        const pattern = String(call.arguments.pattern ?? "").trim();
        if (!pattern) return { ok: false, output: "", error: "pattern is required", summary: "invalid arguments" };
        const workspace = activeRoot(context);
        const base = pathFor(context, call.arguments.path ?? ".");
        const baseInfo = await stat(base);
        if (!baseInfo.isDirectory()) {
          return { ok: false, output: "", error: `search root is not a directory: ${displayPath(workspace, base)}`, summary: "not a directory" };
        }
        const limit = Math.max(1, intArg(call.arguments.limit, DEFAULT_GLOB_LIMIT));
        const matcher = compileGlob(pattern);
        const hits: Array<{ path: string; mtime: number }> = [];
        await walkFiles(base, async (filePath, mtime) => {
          const relFromBase = relative(base, filePath).replaceAll("\\", "/");
          const relFromRoot = relative(workspace, filePath).replaceAll("\\", "/");
          if (matcher(relFromBase) || matcher(relFromRoot) || matcher(filePath.replaceAll("\\", "/"))) {
            hits.push({ path: relFromRoot, mtime });
          }
        });
        hits.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
        const selected = hits.slice(0, limit);
        const truncated = hits.length > selected.length;
        const lines = selected.map((item) => item.path);
        if (truncated) lines.push(`...[truncated ${hits.length - selected.length} more files]`);
        return {
          ok: true,
          output: lines.join("\n") || "no matches",
          summary: truncated ? `${selected.length}/${hits.length} files` : `${hits.length} files`,
          metadata: { total: hits.length, returned: selected.length, truncated },
        };
      } catch (error) {
        return failedResult(error, "glob_files failed");
      }
    },
  });

  register({
    name: "search_code",
    description: "Search file contents with a regular expression. Returns file:line:content hits with a result cap.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source." },
        path: { type: "string", description: "Optional search root relative to workspace. Defaults to .", default: "." },
        glob: { type: "string", description: "Optional file-name glob filter, e.g. *.{ts,tsx}." },
        limit: { type: "integer", description: "Maximum hits to return. Defaults to 200.", default: DEFAULT_SEARCH_LIMIT },
      },
      required: ["pattern"],
    },
    permissionLevel: 0,
    kind: "readonly",
    maxOutputChars: 32_000,
    invoke: async (call, context) => {
      try {
        const source = String(call.arguments.pattern ?? "");
        if (!source) return { ok: false, output: "", error: "pattern is required", summary: "invalid arguments" };
        let regex: RegExp;
        try {
          regex = new RegExp(source);
        } catch (error) {
          return { ok: false, output: "", error: `invalid regular expression: ${errorMessage(error)}`, summary: "invalid regex" };
        }
        const workspace = activeRoot(context);
        const base = pathFor(context, call.arguments.path ?? ".");
        const limit = Math.max(1, intArg(call.arguments.limit, DEFAULT_SEARCH_LIMIT));
        const fileFilter = typeof call.arguments.glob === "string" && call.arguments.glob.trim()
          ? compileGlob(String(call.arguments.glob))
          : undefined;
        const hits: string[] = [];
        let total = 0;
        // 模型提供的正则可能有灾难性回溯:长行截断 + 总时间预算双保险。
        const startedAt = Date.now();
        let timedOut = false;
        await walkFiles(base, async (filePath) => {
          if (hits.length >= limit || timedOut) return;
          const rel = relative(workspace, filePath).replaceAll("\\", "/");
          const name = rel.split("/").pop() ?? rel;
          if (fileFilter && !fileFilter(rel) && !fileFilter(name)) return;
          try {
            const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              if ((index & 0xff) === 0 && Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
                timedOut = true;
                return;
              }
              const line = lines[index] ?? "";
              regex.lastIndex = 0;
              if (!regex.test(line.length > SEARCH_MAX_LINE_LENGTH ? line.slice(0, SEARCH_MAX_LINE_LENGTH) : line)) continue;
              total += 1;
              if (hits.length < limit) {
                hits.push(`${rel}:${index + 1}:${line.trim().slice(0, 200)}`);
              }
            }
          } catch {
            // Skip binary/unreadable files.
          }
        });
        const truncated = total > hits.length;
        if (truncated) hits.push(`...[truncated ${total - hits.length} more matches]`);
        if (timedOut) hits.push(`...[search stopped after ${SEARCH_TIME_BUDGET_MS}ms; results may be incomplete]`);
        return {
          ok: true,
          output: hits.join("\n") || "no matches",
          summary: timedOut
            ? `partial: ${Math.min(total, limit)}/${total}+ matches (time budget reached)`
            : truncated ? `${Math.min(total, limit)}/${total} matches` : `${total} matches`,
          metadata: { total, returned: Math.min(total, limit), truncated, ...(timedOut ? { timedOut: true } : {}) },
        };
      } catch (error) {
        return failedResult(error, "search_code failed");
      }
    },
  });

  for (const [name, args, command] of [
    ["git_status", ["status", "--short", "--branch"], "git"],
    ["get_diff", ["diff", "--stat"], "git"],
  ] as const) {
    register({
     name,
     description: name === "git_status" ? "Show short git status and branch." : "Show the workspace diff stat.",
     parameters: { type: "object", properties: {} },
     permissionLevel: 0,
     kind: "readonly",
     maxOutputChars: 16_000,
    deferred: true,
     invoke: async (_call, context) => {
        try {
          const result = await execFileAsync(command, ["-C", activeRoot(context), ...args], { encoding: "utf8" });
          return { ok: true, output: result.stdout.trim() || "(empty)", summary: "ok" };
        } catch (error) {
          const item = error as { stderr?: string };
          return { ok: false, output: "", error: item.stderr?.trim() || errorMessage(error), summary: "git failed" };
        }
      },
    });
  }

  register({
    name: "run_command",
    description: "Run a shell command with a timeout. Prefer dedicated file/search/edit tools when they provide the needed operation. Returns stdout, stderr, and exit summary.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeout: { type: "number", description: "Timeout in seconds. Defaults to 60.", default: 60 },
        cwd: { type: "string", description: "Optional working directory, relative or absolute, that must remain inside the workspace root. Defaults to the workspace root." },
      },
      required: ["command"],
   },
   permissionLevel: 3,
   kind: "command",
    maxOutputChars: 32_000,
    deferred: true,
    invoke: async (call, context) => {
      const timeout = Math.max(1, numberArg(call.arguments.timeout, 60)) * 1000;
      try {
        const cwd = await resolveCommandCwd(activeRoot(context), call.arguments.cwd);
        const result = await executeCommandWithProcessTree(String(call.arguments.command), {
          cwd,
          timeout,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        if (context?.signal?.aborted) throw new DOMException("operation aborted", "AbortError");
        const output = formatPreservingTail(`${result.stdout}${result.stderr}`);
        return { ok: true, output, summary: "exit 0" };
      } catch (error) {
        if (context?.signal?.aborted || isAbortError(error)) {
          return { ok: false, output: "", error: "command cancelled", summary: "cancelled", metadata: { cancelled: true } };
        }
        const item = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; cmd?: string };
        if (!item.cmd) {
          return { ok: false, output: "", error: errorMessage(error), summary: "invalid arguments" };
        }
        let output = `${item.stdout ?? ""}${item.stderr ?? ""}`;
        const diagnostic = getWindowsCommandDiagnostic(item.cmd, output);
        if (diagnostic) output += diagnostic;
        output = formatPreservingTail(output);
        const result: ToolResult = {
          ok: false,
          output,
          summary: item.killed ? "timed out" : `exit ${String(item.code ?? "unknown")}`,
        };
        if (item.killed) result.error = `command timed out after ${timeout / 1000}s`;
        else if (item.code !== undefined) result.error = `command exited with code ${String(item.code)}`;
        return result;
      }
    },
  });

  registerSearchTools(registry);
  registerWorktreeTools(registry, root);
}

/** 按需工具发现：搜索未激活的 deferred 工具，或用 select:<name> 精确解锁（F19）。 */
function registerSearchTools(registry: ToolRegistry): void {
  registry.register({
    name: "search_tools",
    description:
      "Search inactive deferred tools by keyword. Use query select:<tool-name> to activate a tool and return its schema.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, or select:<tool-name> for exact activation." },
        limit: { type: "integer", description: "Maximum search results, default 20." },
      },
      required: ["query"],
    },
    permissionLevel: 0,
    system: true,
    kind: "readonly",
    maxOutputChars: 16_000,
    invoke: async (call) => {
      const query = typeof call.arguments.query === "string" ? call.arguments.query.trim() : "";
      if (!query) {
        return { ok: false, output: "", error: "query is required", summary: "invalid arguments" };
      }
      if (query.toLowerCase().startsWith("select:")) {
        const requestedName = query.slice("select:".length).trim();
        const name = resolveDeferredToolName(registry, requestedName);
        if (!name) {
          return { ok: false, output: "", error: `tool not found or not discoverable: ${requestedName}`, summary: "tool not found" };
        }
        const tool = registry.activate(name);
        if (!tool) {
          return { ok: false, output: "", error: `tool not found or not discoverable: ${requestedName}`, summary: "tool not found" };
        }
        return {
          ok: true,
          output: JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2),
          summary: `activated ${tool.name}`,
        };
      }
      const limit = Math.min(100, Math.max(1, intArg(call.arguments.limit, 20)));
      const terms = tokenizeToolSearch(query);
      const matches = registry
        .list()
        .filter((tool) => registry.isDeferred(tool) && !registry.isExposed(tool.name))
        .map((tool) => ({ tool, score: toolSearchScore(tool, terms) }))
        .filter((entry): entry is { tool: ToolDefinition; score: number } => entry.score !== undefined)
        .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
        .slice(0, limit)
        .map(({ tool }) => ({ name: tool.name, description: tool.description }));
      return {
        ok: true,
        output: matches.length ? JSON.stringify(matches, null, 2) : "No inactive tools matched the query.",
        summary: `${matches.length} tools found`,
      };
    },
  });
}

function tokenizeToolSearch(value: string): string[] {
  return normalizeToolSearchText(value).split(" ").filter(Boolean);
}

function normalizeToolSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function toolSearchScore(tool: ToolDefinition, terms: readonly string[]): number | undefined {
  const name = normalizeToolSearchText(tool.name);
  const description = normalizeToolSearchText(tool.description);
  const aliases = (TOOL_SEARCH_ALIASES[tool.name] ?? []).map(normalizeToolSearchText);
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 500;
    else if (name.includes(term)) score += 300;
    else if (aliases.some((alias) => alias === term)) score += 200;
    else if (aliases.some((alias) => alias.includes(term))) score += 120;
    else if (description.includes(term)) score += 40;
    else return undefined;
  }
  return score;
}

function resolveDeferredToolName(registry: ToolRegistry, requestedName: string): string | undefined {
  const target = normalizeToolSearchText(requestedName);
  const matches = registry.list().filter((tool) => {
    if (!registry.isDeferred(tool)) return false;
    if (normalizeToolSearchText(tool.name) === target) return true;
    return (TOOL_SEARCH_ALIASES[tool.name] ?? []).some((alias) => normalizeToolSearchText(alias) === target);
  });
  return matches.length === 1 ? matches[0]?.name : undefined;
}

export function isWriteToolName(name: string): boolean {
  return name === "apply_patch" || name === "write_file" || name === "edit_file" || name === "write_plan";
}

export function isMutatingToolName(name: string): boolean {
  return isWriteToolName(name) || name === "run_command" || name === "enter_worktree" || name === "exit_worktree";
}

export function isPlanModeTool(tool: ToolDefinition): boolean {
  return tool.system === true || tool.kind === "readonly" || tool.name === "write_plan";
}

async function writeTextFile(
  root: string,
  target: (raw: unknown) => string,
  rawPath: unknown,
  rawContent: unknown,
): Promise<ToolResult> {
  try {
    const path = target(rawPath);
    await atomicWriteFile(path, String(rawContent ?? ""));
    return {
      ok: true,
      output: `wrote ${displayPath(root, path)}`,
      summary: "wrote file",
    };
  } catch (error) {
    return failedResult(error, "write failed");
  }
}

async function writePlanFile(root: string, rawPath: unknown, rawContent: unknown): Promise<ToolResult> {
  try {
    if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("write_plan path must be a non-empty workspace-relative path");
    const requestedPath = rawPath.trim();
    if (isAbsolute(requestedPath)) throw new Error("write_plan does not accept absolute paths");

    const candidate = resolveWorkspacePath(root, requestedPath);
    const planRoot = resolve(projectStateRoot(root), "plans");
    const planRelative = relative(planRoot, candidate);
    if (!planRelative || isAbsolute(planRelative) || planRelative === ".." || planRelative.startsWith(`..${sep}`)) {
      throw new Error("write_plan path must name a file strictly inside .oran/plans");
    }

    const [physicalRoot, physicalPlanRoot, physicalCandidate] = await Promise.all([
      resolvePhysicalPath(root),
      resolvePhysicalPath(planRoot),
      resolvePhysicalPath(candidate),
    ]);
    if (!physicalRoot || !physicalPlanRoot || !physicalCandidate) throw new Error("write_plan path could not be resolved safely");
    if (!isWithinPath(physicalRoot, physicalPlanRoot) || !isWithinPath(physicalPlanRoot, physicalCandidate)) {
      throw new Error("write_plan path escapes .oran/plans through a symbolic link");
    }

    await atomicWriteFile(candidate, String(rawContent ?? ""));
    return {
      ok: true,
      output: `wrote ${displayPath(root, candidate)}`,
      summary: "wrote plan",
    };
  } catch (error) {
    return failedResult(error, "write_plan failed");
  }
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tempPath, content, "utf8");
    try {
      await rename(tempPath, path);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EEXIST") {
        await copyFile(tempPath, path);
        await unlink(tempPath).catch(() => {});
      } else {
        throw err;
      }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

export function formatPreservingTail(output: string, maxChars = 32_000, headChars = 8_000): string {
  if (!output || output.length <= maxChars) return output;
  const separator = `\n\n... [truncated ${output.length - maxChars} characters, showing head and tail] ...\n\n`;
  const available = Math.max(0, maxChars - separator.length);
  const headLen = Math.min(headChars, Math.floor(available / 3));
  const tailLen = available - headLen;
  return `${output.slice(0, headLen)}${separator}${output.slice(output.length - tailLen)}`;
}

function executeCommandWithProcessTree(
  command: string,
  options: { cwd: string; timeout: number; signal?: AbortSignal | undefined },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let childPid: number | undefined;

    const child = exec(
      command,
      {
        cwd: options.cwd,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        if (timedOut) {
          const timeoutErr = Object.assign(new Error("command timed out"), {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            killed: true,
            cmd: command,
          });
          return reject(timeoutErr);
        }
        if (error) {
          const runErr = Object.assign(error, {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            cmd: command,
          });
          return reject(runErr);
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );

    childPid = child.pid;

    const onAbort = () => {
      killProcessTree(childPid);
      reject(new DOMException("operation aborted", "AbortError"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        killProcessTree(childPid);
        return reject(new DOMException("operation aborted", "AbortError"));
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(childPid);
      }, options.timeout);
      timer.unref?.();
    }
  });
}

function resolveWorkspacePath(root: string, raw: unknown): string {
  return resolveWithinRoot(root, typeof raw === "string" && raw.length ? raw : ".");
}

/** 解析 run_command 的可选 cwd：词法包含 + symlink 物理包含双重防护。 */
async function resolveCommandCwd(root: string, raw: unknown): Promise<string> {
  if (raw === undefined || raw === null || raw === "") return root;
  if (typeof raw !== "string") throw new Error("cwd must be a string path relative to the workspace root");
  const candidate = resolveWorkspacePath(root, raw);
  const [physicalRoot, physicalCandidate] = await Promise.all([
    resolvePhysicalPath(root),
    resolvePhysicalPath(candidate),
  ]);
  if (!physicalRoot || !physicalCandidate) throw new Error(`cwd could not be resolved safely: ${String(raw)}`);
  if (!isWithinPath(physicalRoot, physicalCandidate)) {
    throw new Error(`cwd escapes workspace through a symbolic link: ${String(raw)}`);
  }
  return candidate;
}

function displayPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).replaceAll("\\", "/");
  return rel || ".";
}

function intArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return fallback;
}

function numberArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count += 1;
    start = index + needle.length;
  }
  return count;
}

function compileGlob(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  const regexes = expandBracePatterns(normalized).map((item) => new RegExp(`^${globSource(item)}$`, "i"));
  return (path: string) => {
    const candidate = path.replaceAll("\\", "/");
    return regexes.some((regex) => regex.test(candidate));
  };
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

function expandBracePatterns(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const alternatives = pattern.slice(open + 1, close).split(",").filter(Boolean);
  if (alternatives.length < 2) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  return alternatives
    .slice(0, 32)
    .flatMap((alternative) => expandBracePatterns(`${prefix}${alternative}${suffix}`))
    .slice(0, 32);
}

async function walkFiles(
  directory: string,
  visit: (filePath: string, mtime: number) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(fullPath);
      await visit(fullPath, info.mtimeMs);
    } catch {
      // Skip unreadable entries.
    }
  }
}

function failedResult(error: unknown, fallback: string): ToolResult {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") {
    return { ok: false, output: "", error: `path not found: ${errorMessage(error)}`, summary: "not found" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { ok: false, output: "", error: `permission denied: ${errorMessage(error)}`, summary: "permission denied" };
  }
  return { ok: false, output: "", error: errorMessage(error) || fallback, summary: "error" };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getWindowsCommandDiagnostic(cmd: string, output: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const hints: string[] = [];
  const trimmedCmd = cmd.trim();

  if (trimmedCmd.includes("'")) {
    hints.push("Windows cmd.exe does not treat single quotes ('') as quote delimiters. Use double quotes (\"\") for arguments and strings.");
  }

  const unixToolMapping: Record<string, string> = {
    grep: "search_code",
    rg: "search_code",
    findstr: "search_code",
    cat: "read_file",
    head: "read_file",
    tail: "read_file",
    ls: "list_files",
    dir: "list_files",
    find: "list_files",
    sed: "edit_file or apply_patch",
    awk: "edit_file",
    rm: "dedicated file operations",
    cp: "dedicated file operations",
    mv: "dedicated file operations",
    touch: "write_file",
  };

  const firstWord = trimmedCmd.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (unixToolMapping[firstWord]) {
    hints.push(`Command '${firstWord}' failed or may be unavailable on Windows. Prefer the native agent tool: ${unixToolMapping[firstWord]}.`);
  }

  if (
    /is not recognized as an internal or external command/i.test(output) ||
    /The term .* is not recognized/i.test(output)
  ) {
    if (!hints.some((h) => h.includes("native agent tool"))) {
      hints.push("If you are trying to read, search, or edit files, use dedicated agent tools (read_file, search_code, list_files, edit_file) instead of shell utilities.");
    }
  }

  if (hints.length === 0) return undefined;
  return `\n[Windows Diagnostic Hint]\n${hints.map((h) => `• ${h}`).join("\n")}`;
}
