import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { ToolFactoryContext } from "./registry.js";
import { compileGlob, walkFiles } from "./glob.js";
import { displayPath, errorMessage, failedResult, intArg } from "./fs-helpers.js";

const execFileAsync = promisify(execFile);

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LINE_CHARS = 2_000;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 200;
/** 灾难性回溯需要长输入;超长行只匹配前缀。 */
const SEARCH_MAX_LINE_LENGTH = 4_096;
/** 搜索总时间预算,超时返回部分结果。 */
const SEARCH_TIME_BUDGET_MS = 2_000;

const pathSchema = {
  type: "object",
  properties: { path: { type: "string", description: "Path relative to workspace root." } },
  required: ["path"],
};

export function registerReadTools(registry: { register(tool: ToolDefinition): void }, ctx: ToolFactoryContext): void {
  const { activeRoot, pathFor } = ctx;
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
          return {
            ok: false,
            output: "",
            error: `not a directory: ${displayPath(workspace, dir)}`,
            summary: "not a directory",
          };
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
    description:
      "Read a UTF-8 text file with optional 1-based start line offset and line limit. Output includes line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        offset: { type: "integer", description: "1-based start line. Defaults to 1.", default: 1 },
        limit: {
          type: "integer",
          description: "Maximum number of lines to return. Defaults to 200.",
          default: DEFAULT_READ_LIMIT,
        },
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
          return {
            ok: false,
            output: "",
            error: `path is a directory: ${displayPath(workspace, path)}`,
            summary: "is directory",
          };
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
          // 超长单行(如压缩过的 JS)截断,避免一行撑爆整个输出预算。
          const text =
            line.length > MAX_READ_LINE_CHARS ? `${line.slice(0, MAX_READ_LINE_CHARS)}...[line truncated]` : line;
          return `${lineNo}|${text}`;
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
    name: "glob_files",
    description:
      "Find files by glob pattern under the workspace (supports *, **, ?, and brace alternatives such as *.{ts,tsx}). Ignores VCS/dependency/build directories. Results are sorted by newest mtime first and capped.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts or src/**/*.md" },
        path: {
          type: "string",
          description: "Optional search root relative to workspace. Defaults to .",
          default: ".",
        },
        limit: {
          type: "integer",
          description: "Maximum paths to return. Defaults to 200.",
          default: DEFAULT_GLOB_LIMIT,
        },
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
          return {
            ok: false,
            output: "",
            error: `search root is not a directory: ${displayPath(workspace, base)}`,
            summary: "not a directory",
          };
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
        path: {
          type: "string",
          description: "Optional search root relative to workspace. Defaults to .",
          default: ".",
        },
        glob: { type: "string", description: "Optional file-name glob filter, e.g. *.{ts,tsx}." },
        limit: {
          type: "integer",
          description: "Maximum hits to return. Defaults to 200.",
          default: DEFAULT_SEARCH_LIMIT,
        },
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
          return {
            ok: false,
            output: "",
            error: `invalid regular expression: ${errorMessage(error)}`,
            summary: "invalid regex",
          };
        }
        const workspace = activeRoot(context);
        const base = pathFor(context, call.arguments.path ?? ".");
        const limit = Math.max(1, intArg(call.arguments.limit, DEFAULT_SEARCH_LIMIT));
        const fileFilter =
          typeof call.arguments.glob === "string" && call.arguments.glob.trim()
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
              if (!regex.test(line.length > SEARCH_MAX_LINE_LENGTH ? line.slice(0, SEARCH_MAX_LINE_LENGTH) : line))
                continue;
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
            : truncated
              ? `${Math.min(total, limit)}/${total} matches`
              : `${total} matches`,
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
      // 高频只读工具常驻暴露:延迟发现省下的两个 schema 换不来一整轮模型往返。
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
}
