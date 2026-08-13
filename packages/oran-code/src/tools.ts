import { exec, execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";
import { projectStateRoot } from "./paths.js";
import { applyUnifiedDiff } from "./patch.js";
import { registerWorktreeTools } from "./worktree/tools.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  ".oran",
  ".litecode",
  ".liteagent",
  "coverage",
  ".next",
  ".turbo",
]);

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 200;

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
    if (this.isDeferred(tool) && !this.activated.has(call.name)) {
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
        await writeFile(path, next, "utf8");
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

  // Compatibility alias: full-file overwrite. Prefer write_file for new writes and edit_file for surgical edits.
  register({
    name: "apply_patch",
    description:
      "Compatibility tool: overwrite a text file with full content (not a unified diff). Read existing files first. Prefer write_file for new files and edit_file for unique-snippet edits.",
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
    invoke: async (call, context) => writeTextFile(activeRoot(context), (raw) => pathFor(context, raw), call.arguments.path, call.arguments.content),
  });

  register({
    name: "apply_diff",
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
            error: `apply_diff failed: ${applied.error ?? "unknown error"}`,
            summary: "patch failed",
          };
        }
        await writeFile(path, applied.content, "utf8");
        return {
          ok: true,
          output: `applied ${applied.hunksApplied} hunk(s) to ${displayPath(workspace, path)} (+${applied.linesAdded}/-${applied.linesRemoved})`,
          summary: `applied ${applied.hunksApplied} hunks`,
          metadata: { hunksApplied: applied.hunksApplied, linesAdded: applied.linesAdded, linesRemoved: applied.linesRemoved },
        };
      } catch (error) {
        return failedResult(error, "apply_diff failed");
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
        await walkFiles(base, async (filePath) => {
          if (hits.length >= limit) return;
          const rel = relative(workspace, filePath).replaceAll("\\", "/");
          const name = rel.split("/").pop() ?? rel;
          if (fileFilter && !fileFilter(rel) && !fileFilter(name)) return;
          try {
            const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              regex.lastIndex = 0;
              if (!regex.test(lines[index] ?? "")) continue;
              total += 1;
              if (hits.length < limit) {
                hits.push(`${rel}:${index + 1}:${(lines[index] ?? "").trim().slice(0, 200)}`);
              }
            }
          } catch {
            // Skip binary/unreadable files.
          }
        });
        const truncated = total > hits.length;
        if (truncated) hits.push(`...[truncated ${total - hits.length} more matches]`);
        return {
          ok: true,
          output: hits.join("\n") || "no matches",
          summary: truncated ? `${Math.min(total, limit)}/${total} matches` : `${total} matches`,
          metadata: { total, returned: Math.min(total, limit), truncated },
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
      invoke: async (call, context) => {
        const timeout = Math.max(1, numberArg(call.arguments.timeout, 60)) * 1000;
        try {
        const cwd = await resolveCommandCwd(activeRoot(context), call.arguments.cwd);
        const result = await execAsync(String(call.arguments.command), {
          cwd,
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        if (context?.signal?.aborted) throw new DOMException("operation aborted", "AbortError");
        return { ok: true, output: `${result.stdout}${result.stderr}`, summary: "exit 0" };
      } catch (error) {
        if (context?.signal?.aborted || isAbortError(error)) {
          return { ok: false, output: "", error: "command cancelled", summary: "cancelled", metadata: { cancelled: true } };
        }
        const item = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; cmd?: string };
        if (!item.cmd) {
          return { ok: false, output: "", error: errorMessage(error), summary: "invalid arguments" };
        }
        const result: ToolResult = {
          ok: false,
          output: `${item.stdout ?? ""}${item.stderr ?? ""}`,
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
        const name = query.slice("select:".length).trim();
        const tool = registry.activate(name);
        if (!tool) {
          return { ok: false, output: "", error: `tool not found or not discoverable: ${name}`, summary: "tool not found" };
        }
        return {
          ok: true,
          output: JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2),
          summary: `activated ${tool.name}`,
        };
      }
      const limit = Math.min(100, Math.max(1, intArg(call.arguments.limit, 20)));
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = registry
        .list()
        .filter((tool) => registry.isDeferred(tool) && !registry.isExposed(tool.name))
        .filter((tool) => terms.every((term) => `${tool.name} ${tool.description}`.toLowerCase().includes(term)))
        .slice(0, limit)
        .map((tool) => ({ name: tool.name, description: tool.description }));
      return {
        ok: true,
        output: matches.length ? JSON.stringify(matches, null, 2) : "No inactive tools matched the query.",
        summary: `${matches.length} tools found`,
      };
    },
  });
}

export function isWriteToolName(name: string): boolean {
  return name === "apply_patch" || name === "write_file" || name === "edit_file" || name === "write_plan" || name === "apply_diff";
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
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, String(rawContent ?? ""), "utf8");
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
      resolvePhysicalCandidate(root),
      resolvePhysicalCandidate(planRoot),
      resolvePhysicalCandidate(candidate),
    ]);
    if (!physicalRoot || !physicalPlanRoot || !physicalCandidate) throw new Error("write_plan path could not be resolved safely");
    if (!isWithinPath(physicalRoot, physicalPlanRoot) || !isWithinPath(physicalPlanRoot, physicalCandidate)) {
      throw new Error("write_plan path escapes .oran/plans through a symbolic link");
    }

    await mkdir(dirname(candidate), { recursive: true });
    await writeFile(candidate, String(rawContent ?? ""), "utf8");
    return {
      ok: true,
      output: `wrote ${displayPath(root, candidate)}`,
      summary: "wrote plan",
    };
  } catch (error) {
    return failedResult(error, "write_plan failed");
  }
}

async function resolvePhysicalCandidate(path: string): Promise<string | undefined> {
  const tail: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      await lstat(cursor);
      return resolve(await realpath(cursor), ...tail.reverse());
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      tail.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root);
  const normalizedCandidate = comparablePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveWorkspacePath(root: string, raw: unknown): string {
  const candidate = resolve(root, typeof raw === "string" && raw.length ? raw : ".");
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) {
    throw new Error(`path escapes workspace: ${String(raw)}`);
  }
  if (candidate !== root && !candidate.startsWith(root + sep) && !candidate.startsWith(root + "/")) {
    throw new Error(`path escapes workspace: ${String(raw)}`);
  }
  return candidate;
}

/** 解析 run_command 的可选 cwd：词法包含 + symlink 物理包含双重防护。 */
async function resolveCommandCwd(root: string, raw: unknown): Promise<string> {
  if (raw === undefined || raw === null || raw === "") return root;
  if (typeof raw !== "string") throw new Error("cwd must be a string path relative to the workspace root");
  const candidate = resolveWorkspacePath(root, raw);
  const [physicalRoot, physicalCandidate] = await Promise.all([
    resolvePhysicalCandidate(root),
    resolvePhysicalCandidate(candidate),
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

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}
