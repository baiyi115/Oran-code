import type { ToolDefinition } from "../types.js";
import type { ToolRegistry } from "./registry.js";
import { TOOL_SEARCH_ALIASES } from "./predicates.js";
import { intArg } from "./fs-helpers.js";

/** 按需工具发现：搜索未激活的 deferred 工具，或用 select:<name> 精确解锁（F19）。 */
export function registerSearchTools(registry: ToolRegistry): void {
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
