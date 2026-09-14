import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { projectStateRoot } from "../paths.js";
import { applyUnifiedDiff } from "../patch.js";
import { resolvePhysicalPath, isWithinPath } from "../utils/path-containment.js";
import type { ToolFactoryContext } from "./registry.js";
import { atomicWriteFile, countOccurrences, displayPath, failedResult, resolveWorkspacePath } from "./fs-helpers.js";

export function registerWriteTools(registry: { register(tool: ToolDefinition): void }, ctx: ToolFactoryContext): void {
  const { activeRoot, pathFor } = ctx;
  const register = (tool: ToolDefinition): void => {
    registry.register(tool);
  };

  register({
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside the workspace. Read an existing target before overwriting it. Parent directories are created automatically.",
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
    invoke: async (call, context) =>
      writeTextFile(activeRoot(context), (raw) => pathFor(context, raw), call.arguments.path, call.arguments.content),
  });

  register({
    name: "write_plan",
    description: `Create or overwrite a UTF-8 plan file. The path must be workspace-relative and strictly inside ${ctx.planDirectory}. This is the only write tool exposed in plan mode.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: `Workspace-relative path inside ${ctx.planDirectory}.` },
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
      "Replace text in an existing file after reading it. Supports single replacement via old_string/new_string, or multiple disjoint replacements via edits[]. By default old_string must match exactly once; set replace_all=true for single replacement to replace every match. Returns a clear error when match count is 0 or >1.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root." },
        old_string: {
          type: "string",
          description: "Exact text to find (for single replacement when edits is not provided).",
        },
        new_string: {
          type: "string",
          description: "Replacement text (for single replacement when edits is not provided).",
        },
        replace_all: {
          type: "boolean",
          description: "Replace every match instead of requiring a unique match (single replacement only).",
          default: false,
        },
        edits: {
          type: "array",
          description:
            "One or more targeted replacements to apply atomically. Each item must specify old_string (unique exact text) and new_string. Matched against the original file; edits must not overlap.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Exact text for one targeted replacement." },
              new_string: { type: "string", description: "Replacement text for this targeted edit." },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
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
          return {
            ok: false,
            output: "",
            error: `path is a directory: ${displayPath(workspace, path)}`,
            summary: "is directory",
          };
        }

        const rawEdits = call.arguments.edits;
        if (Array.isArray(rawEdits)) {
          if (rawEdits.length === 0) {
            return { ok: false, output: "", error: "edits array must not be empty", summary: "invalid arguments" };
          }
          const content = await readFile(path, "utf8");
          const isCrlf = content.includes("\r\n");
          const normalizedContent = content.replace(/\r\n/g, "\n");

          interface EditRange {
            startIndex: number;
            endIndex: number;
            normalizedNew: string;
            rawIndex: number;
          }
          const ranges: EditRange[] = [];

          for (let i = 0; i < rawEdits.length; i++) {
            const item = rawEdits[i];
            if (!item || typeof item !== "object") {
              return { ok: false, output: "", error: `edits[${i}] must be an object`, summary: "invalid arguments" };
            }
            const oldStr = String((item as Record<string, unknown>).old_string ?? "");
            const newStr = String((item as Record<string, unknown>).new_string ?? "");
            if (!oldStr) {
              return {
                ok: false,
                output: "",
                error: `edits[${i}].old_string must not be empty`,
                summary: "invalid arguments",
              };
            }
            const normalizedOld = oldStr.replace(/\r\n/g, "\n");
            const normalizedNew = newStr.replace(/\r\n/g, "\n");
            const count = countOccurrences(normalizedContent, normalizedOld);
            if (count === 0) {
              return {
                ok: false,
                output: "",
                error: `edits[${i}].old_string matched 0 times in ${displayPath(workspace, path)}; provide a unique exact snippet`,
                summary: "0 matches",
                metadata: { editIndex: i, matches: 0 },
              };
            }
            if (count > 1) {
              return {
                ok: false,
                output: "",
                error: `edits[${i}].old_string matched ${count} times in ${displayPath(workspace, path)}; provide a unique exact snippet with more surrounding context`,
                summary: `${count} matches`,
                metadata: { editIndex: i, matches: count },
              };
            }
            const startIndex = normalizedContent.indexOf(normalizedOld);
            const endIndex = startIndex + normalizedOld.length;
            ranges.push({ startIndex, endIndex, normalizedNew, rawIndex: i });
          }

          // Check for overlapping edits
          const sortedByStart = [...ranges].sort((a, b) => a.startIndex - b.startIndex);
          for (let i = 0; i < sortedByStart.length - 1; i++) {
            const current = sortedByStart[i]!;
            const next = sortedByStart[i + 1]!;
            if (current.endIndex > next.startIndex) {
              return {
                ok: false,
                output: "",
                error: `edits[${current.rawIndex}] and edits[${next.rawIndex}] overlap in ${displayPath(workspace, path)}; merge nearby changes into a single edit`,
                summary: "overlapping edits",
              };
            }
          }

          // Apply from back to front to preserve offsets
          sortedByStart.sort((a, b) => b.startIndex - a.startIndex);
          let resultNormalized = normalizedContent;
          for (const item of sortedByStart) {
            resultNormalized =
              resultNormalized.slice(0, item.startIndex) + item.normalizedNew + resultNormalized.slice(item.endIndex);
          }
          const next = isCrlf ? resultNormalized.replace(/\n/g, "\r\n") : resultNormalized;
          await atomicWriteFile(path, next);
          return {
            ok: true,
            output: `edited ${displayPath(workspace, path)} (${ranges.length} batch replacement${ranges.length === 1 ? "" : "s"})`,
            summary: `batch ${ranges.length} edits`,
            metadata: { matches: ranges.length, batch: true },
          };
        }

        const oldString = String(call.arguments.old_string ?? "");
        const newString = String(call.arguments.new_string ?? "");
        if (!oldString) {
          return {
            ok: false,
            output: "",
            error: "old_string must not be empty (or provide edits array)",
            summary: "invalid arguments",
          };
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
          metadata: {
            hunksApplied: applied.hunksApplied,
            linesAdded: applied.linesAdded,
            linesRemoved: applied.linesRemoved,
          },
        };
      } catch (error) {
        return failedResult(error, "apply_patch failed");
      }
    },
  });
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
    if (typeof rawPath !== "string" || !rawPath.trim())
      throw new Error("write_plan path must be a non-empty workspace-relative path");
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
    if (!physicalRoot || !physicalPlanRoot || !physicalCandidate)
      throw new Error("write_plan path could not be resolved safely");
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
