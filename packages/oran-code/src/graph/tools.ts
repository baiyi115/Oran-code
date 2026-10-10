import type { ToolRegistry, ToolFactoryContext } from "../tools.js";
import type { ToolCall, ToolExecutionContext, ToolResult } from "../types.js";
import { ensureGraph, type GraphHandle } from "./store.js";
import { callers, dependents, isTestFile, symbolsInFile } from "./query.js";
import { registeredLanguages, type GraphIndex } from "./languages/registry.js";

/**
 * The single graph tool. Returns structure only (paths, distances, counts),
 * never source code — reading files stays the model's decision.
 */

const MAX_LISTED_ROWS = 60;
const MAX_OUTPUT_CHARS = 16_000;

export function registerGraphTools(registry: ToolRegistry, factory: ToolFactoryContext): void {
  const tool = {
    name: "code_impact",
    description:
      "Answer \"if I change this file, what else is affected?\" from a prebuilt code dependency graph. " +
      "Returns the files that (directly or transitively) import the given file, optionally limited to test files. " +
      "Covers TypeScript/TSX/JS, Python, and Go. Use it before modifying a widely-referenced file instead of " +
      "grepping for the name or reading candidate files one by one. Returns structure only, not source code. " +
      "The index is built lazily on first use and stored under .oran/graph/.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to analyze, relative to the workspace root." },
        depth: {
          type: "integer",
          description: "Traversal depth: 1 = direct importers only. Defaults to 2.",
          default: 2,
          minimum: 1,
          maximum: 8,
        },
        mode: {
          type: "string",
          description:
            "dependents = all affected files; tests = only affected test files; callers = statically determined callers of the file's symbols.",
          enum: ["dependents", "tests", "callers"],
          default: "dependents",
        },
        symbol: {
          type: "string",
          description: "With mode=callers, limit results to callers of this symbol name instead of all symbols in the file.",
        },
        rebuild: { type: "boolean", description: "Force a full rebuild of the index. Defaults to false." },
      },
      required: ["path"],
    },
    permissionLevel: 0,
    kind: "readonly" as const,
    // The result reflects the workspace's current on-disk state.
    cacheable: false,
    maxOutputChars: MAX_OUTPUT_CHARS,
    invoke: (call: ToolCall, context?: ToolExecutionContext) => runImpactQuery(factory, call, context),
  };
  registry.register(tool);
}

async function runImpactQuery(
  factory: ToolFactoryContext,
  call: ToolCall,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const rawPath = call.arguments.path;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return failed("path is required: pass the workspace-relative file to analyze.");
  }
  const root = factory.activeRoot(context);
  const depth = clampDepth(call.arguments.depth);
  const mode = call.arguments.mode === "tests" ? "tests" : call.arguments.mode === "callers" ? "callers" : "dependents";
  const rebuild = call.arguments.rebuild === true;

  let handle;
  try {
    handle = await ensureGraph(root, { rebuild });
  } catch (error) {
    return failed(`code_impact could not build the dependency graph: ${errorText(error)}`);
  }
  const index = handle.index;

  if (registeredLanguages().length === 0 || countLanguages(index) === 0) {
    return {
      ok: true,
      output:
        "This workspace contains no files in languages covered by the dependency graph " +
        "(currently TypeScript/TSX/JS, Python, Go). Use search_code instead; " +
        `nothing was misreported: 0 files indexed, 0 edges.`,
      summary: "workspace not covered by the graph",
    };
  }

  let target: string;
  try {
    const absolute = factory.pathFor(context, rawPath);
    target = absolute.slice(root.length).replaceAll("\\", "/").replace(/^\//, "");
  } catch {
    return failed(`path escapes the workspace: ${rawPath}`);
  }
  if (!index.languages[target]) {
    const known = index.files.includes(target);
    return failed(
      known
        ? `${target} is in the workspace but its language is not covered by the graph; use search_code for it.`
        : `${target} is not part of the indexed workspace (${index.files.length} files). Check the path spelling.`,
    );
  }

  const impacted = dependents(index, target, depth);
  const selected = mode === "tests" ? impacted.filter((file) => isTestFile(file.path)) : impacted;
  const directCount = impacted.filter((file) => file.distance === 1).length;

  const rows: string[] = [];
  if (mode === "callers") {
    const symbolName = typeof call.arguments.symbol === "string" ? call.arguments.symbol : undefined;
    const targetSymbols = symbolsInFile(index, target);
    if (targetSymbols.length === 0) {
      rows.push(`No symbol-level information for ${target} (call edges cover TypeScript/TSX/JS and Python).`);
    } else {
      const found = callers(index, symbolName).filter((entry) => entry.calleeFile === target);
      rows.push(
        symbolName
          ? `Callers of ${target}#${symbolName}: ${found.length} static call site(s)`
          : `Static callers of symbols defined in ${target}: ${found.length} call site(s)`,
      );
      const listed = found.slice(0, MAX_LISTED_ROWS);
      for (const entry of listed) rows.push(`  ${entry.caller} -> ${entry.callee}`);
      if (found.length > listed.length) rows.push(`  ... and ${found.length - listed.length} more`);
      if (found.length === 0) rows.push("  (no statically determinable callers; dynamic dispatch is not resolved)");
    }
  } else if (selected.length === 0) {
    rows.push(
      mode === "tests"
        ? `No test files import ${target} (directly or within depth ${depth}).`
        : `Nothing imports ${target} within depth ${depth}; it is a leaf in the dependency graph.`,
    );
  } else {
    rows.push(`Files ${mode === "tests" ? "testing" : "depending on"} ${target} (depth ${depth}): ${selected.length} total, ${directCount} direct`);
    const listed = selected.slice(0, MAX_LISTED_ROWS);
    for (const file of listed) rows.push(`  [${file.distance}] ${file.path}`);
    if (selected.length > listed.length) rows.push(`  ... and ${selected.length - listed.length} more`);
  }
  rows.push("");
  rows.push(disclosure(index, target, handle));
  return { ok: true, output: rows.join("\n"), summary: `${selected.length} affected file(s)` };
}

function disclosure(index: GraphIndex, target: string, handle: GraphHandle): string {
  const byLanguage = new Map<string, number>();
  for (const language of Object.values(index.languages)) {
    byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
  }
  const distribution = [...byLanguage.entries()].sort().map(([language, count]) => `${language} ${count}`).join(", ");

  const byReason = new Map<string, number>();
  for (const entry of Object.values(index.unresolved).flat()) {
    byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  const reasonSummary = [...byReason.entries()].sort().map(([reason, count]) => `${count} ${reason}`).join(", ");

  const targetUnresolved = index.unresolved[target] ?? [];
  const targetByReason = new Map<string, number>();
  for (const entry of targetUnresolved) targetByReason.set(entry.reason, (targetByReason.get(entry.reason) ?? 0) + 1);
  const targetSummary = [...targetByReason.entries()].map(([reason, count]) => `${count} ${reason}`).join(", ");

  const lines = [
    `index: ${index.files.length} files (${distribution || "no languages"}) · ${handle.cached ? "cache hit" : handle.incremental ? "incremental rebuild" : "rebuilt"} · built ${index.builtAt}`,
  ];
  if (reasonSummary) lines.push(`unresolved overall: ${reasonSummary}`);
  lines.push(
    targetSummary
      ? `unresolved in this file: ${targetUnresolved.length} — ${targetSummary}`
      : `unresolved in this file: 0`,
  );
  return lines.join("\n");
}

function countLanguages(index: GraphIndex): number {
  return new Set(Object.values(index.languages)).size;
}

function clampDepth(value: unknown): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(8, Math.max(1, parsed));
}

function failed(error: string): ToolResult {
  return { ok: false, output: "", error, summary: "code_impact failed" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
