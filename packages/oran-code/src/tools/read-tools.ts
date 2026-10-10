import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "../types.js";
import type { ToolFactoryContext } from "./registry.js";
import { compileGlob, walkFiles } from "./glob.js";
import { searchWithDeadline } from "./search-service.js";
import { displayPath, errorMessage, failedResult, intArg } from "./fs-helpers.js";

const execFileAsync = promisify(execFile);

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LINE_CHARS = 2_000;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 200;
/** Total time budget for a search; the search host is killed shortly after it. */
const SEARCH_TIME_BUDGET_MS = 2_000;

/** A short "a, b, c, …" for a notice line, without spelling out hundreds of paths. */
function describePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown}, …` : shown;
}

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
          // Truncate an over-long single line (e.g. minified JS) so one line cannot blow the whole
          // output budget.
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
    name: "show_signature",
    description:
      "Extract structural outline from a source file (functions, classes, interfaces, types, imports, exports) with line numbers without reading implementation bodies. Use this to quickly inspect large files and save tokens.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        only: {
          type: "string",
          description: "Optional category filter: 'signatures', 'imports', 'exports', 'interfaces', 'types'.",
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
        const targetPath = pathFor(context, call.arguments.path);
        const only = typeof call.arguments.only === "string" ? call.arguments.only.trim() : undefined;
        const cliPath = resolveShowSignatureCli();

        if (cliPath) {
          const args = ["map"];
          if (only) args.push("--only", only);
          args.push(targetPath);
          try {
            const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
              cwd: workspace,
              maxBuffer: 5 * 1024 * 1024,
            });
            if (stdout && stdout.trim()) {
              const rel = displayPath(workspace, targetPath);
              return {
                ok: true,
                output: stdout.trim(),
                summary: `${rel} (${stdout.trim().split("\n").length} items)`,
              };
            }
          } catch {
            // Fall back to built-in outline extractor
          }
        }

        const outline = await extractFileOutline(targetPath, only);
        const rel = displayPath(workspace, targetPath);
        return {
          ok: true,
          output: outline || "no signatures or structural declarations found",
          summary: `${rel} (${outline ? outline.split("\n").length : 0} items)`,
        };
      } catch (error) {
        return failedResult(error, "show_signature failed");
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
        // A directory the walk cannot list loses its whole subtree, and the caller
        // reading "no matches" concludes the file is not there. The graph side
        // already reports these; the listing has to as well.
        const unreadable: string[] = [];
        await walkFiles(
          base,
          async (filePath, mtime) => {
            const relFromBase = relative(base, filePath).replaceAll("\\", "/");
            const relFromRoot = relative(workspace, filePath).replaceAll("\\", "/");
            if (matcher(relFromBase) || matcher(relFromRoot) || matcher(filePath.replaceAll("\\", "/"))) {
              hits.push({ path: relFromRoot, mtime });
            }
          },
          (failure) => unreadable.push(relative(workspace, failure.path).replaceAll("\\", "/") || failure.path),
        );
        hits.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
        const selected = hits.slice(0, limit);
        const truncated = hits.length > selected.length;
        const lines = selected.map((item) => item.path);
        if (truncated) lines.push(`...[truncated ${hits.length - selected.length} more files]`);
        if (unreadable.length > 0)
          lines.push(`...[could not read ${unreadable.length} path(s): ${describePaths(unreadable)}]`);
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
        try {
          // Rejected here rather than after a spawn: a bad pattern is an argument
          // error, and the answer should not cost a process.
          new RegExp(source);
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
        const glob =
          typeof call.arguments.glob === "string" && call.arguments.glob.trim()
            ? String(call.arguments.glob)
            : undefined;
        // The scan runs in the search host, which can be killed: a model-supplied
        // pattern may backtrack catastrophically on a short input, and the scan's
        // own budget is checked between lines, so it cannot interrupt one match.
        const outcome = await searchWithDeadline({
          root: workspace,
          base,
          pattern: source,
          glob,
          limit,
          budgetMs: SEARCH_TIME_BUDGET_MS,
        });
        const hits = [...outcome.hits];
        const truncated = outcome.total > hits.length;
        if (truncated) hits.push(`...[truncated ${outcome.total - hits.length} more matches]`);
        if (outcome.timedOut && !outcome.interrupted) {
          hits.push(`...[search stopped after ${SEARCH_TIME_BUDGET_MS}ms; results may be incomplete]`);
        }
        if (outcome.interrupted) {
          hits.push(
            "...[search interrupted: this pattern can take exponential time on some input (nested quantifiers " +
              "such as (a+)+ do), so it was stopped. Simplify the pattern and search again.]",
          );
        }
        // A subtree the walk could not list is missing from this search, and a model
        // reading "no matches" otherwise concludes the text is not in the repository.
        if (outcome.unreadable.length > 0) {
          hits.push(`...[could not read ${outcome.unreadable.length} path(s): ${describePaths(outcome.unreadable)}]`);
        }
        return {
          ok: true,
          output: hits.join("\n") || "no matches",
          summary: outcome.interrupted
            ? `interrupted: ${hits.length} hit(s) before the pattern was stopped`
            : outcome.timedOut
              ? `partial: ${Math.min(outcome.total, limit)}/${outcome.total}+ matches (time budget reached)`
              : truncated
                ? `${Math.min(outcome.total, limit)}/${outcome.total} matches`
                : `${outcome.total} matches`,
          metadata: {
            total: outcome.total,
            returned: Math.min(outcome.total, hits.length),
            truncated,
            ...(outcome.timedOut ? { timedOut: true } : {}),
            ...(outcome.interrupted ? { interrupted: true } : {}),
          },
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
      // High-frequency readonly tools stay exposed: the two schemas saved by deferring discovery
      // are not worth a whole extra model round trip.
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

let cachedShowSignatureCliPath: string | null | undefined;

/**
 * The optional external outline CLI, looked up in the user's own installation
 * only.
 *
 * A `<cwd>/node_modules/showsignature/dist/02-cli.js` candidate used to be here.
 * Since the agent is normally started inside the repository it is asked about,
 * that candidate is workspace-controlled, and show_signature is
 * `permissionLevel: 0, kind: "readonly"` — which the permission layer allows in
 * every mode, without a prompt. Reproduced: a payload at that path ran and its
 * output was returned to the model. The negative result is not cached either, so
 * a later check cannot be answered from a stale miss.
 */
function resolveShowSignatureCli(): string | undefined {
  if (cachedShowSignatureCliPath) return cachedShowSignatureCliPath;
  const candidate = join(homedir(), ".pi", "agent", "npm", "node_modules", "showsignature", "dist", "02-cli.js");
  cachedShowSignatureCliPath = existsSync(candidate) ? candidate : null;
  return cachedShowSignatureCliPath ?? undefined;
}

async function extractFileOutline(targetPath: string, only?: string): Promise<string> {
  const content = await readFile(targetPath, "utf8");
  const lines = content.split(/\r?\n/);
  const results: string[] = [];
  const wantImports = !only || only === "imports";
  const wantExports = !only || only === "exports";
  const wantTypes = !only || only === "types" || only === "interfaces";
  const wantSignatures = !only || only === "signatures";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;

    const isImport = line.startsWith("import ") || line.startsWith("require(");
    if (isImport && wantImports) {
      results.push(`${i + 1} ${line}`);
      continue;
    }

    const isExport = line.startsWith("export ");
    // A function or class declaration is listed by the signature branch below, so it
    // is skipped here to avoid listing one line twice — but only when that branch
    // runs: with `only: "exports"` it does not, and every exported function and
    // class used to disappear from the answer.
    const matchedAsSignature = line.includes("function") || line.includes("class");
    if (isExport && wantExports && !(matchedAsSignature && wantSignatures)) {
      results.push(`${i + 1} ${line.slice(0, 120)}`);
      continue;
    }

    const isTypeOrInterface =
      line.startsWith("interface ") ||
      line.startsWith("type ") ||
      line.startsWith("export interface ") ||
      line.startsWith("export type ") ||
      line.startsWith("enum ") ||
      line.startsWith("export enum ");
    if (isTypeOrInterface && wantTypes) {
      results.push(`${i + 1} ${line.slice(0, 120)}`);
      continue;
    }

    const isSignature =
      line.includes("function ") ||
      line.startsWith("def ") ||
      line.startsWith("async def ") ||
      line.startsWith("class ") ||
      line.startsWith("export class ") ||
      line.startsWith("func ") ||
      line.startsWith("pub fn ");
    if (isSignature && wantSignatures) {
      const truncated = line.length > 140 ? `${line.slice(0, 137)}...` : line;
      results.push(`${i + 1} ${truncated}`);
    }
  }
  return results.join("\n");
}
