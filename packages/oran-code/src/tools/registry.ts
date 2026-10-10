import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from "../types.js";

/**
 * Shared context for builtin tool registration: used by each tool family's register function
 * (same injection pattern as registerWorktreeTools).
 */
export interface ToolFactoryContext {
  /** Workspace root directory (absolute path). */
  readonly root: string;
  /** Display path of the plan directory relative to the workspace (used in the write_plan description). */
  readonly planDirectory: string;
  /** Currently effective workspace root: taken from the execution context when available,
   * otherwise falls back to root. */
  activeRoot(context?: ToolExecutionContext): string;
  /** Resolve a workspace-relative path; throws when it escapes the workspace. */
  pathFor(context: ToolExecutionContext | undefined, raw: unknown): string;
}

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
      return {
        ok: false,
        output: "",
        error: `tool is not activated: ${call.name}; discover it with search_tools first`,
        summary: "not activated",
      };
    }
    const result = await tool.invoke(call, context);
    // Optional post-processing runs before the central truncation: denoise first, then cap, so
    // ANSI sequences and repeated lines do not eat into the truncation budget. A failed cleanup
    // does not affect the result; the raw output is kept.
    if (tool.postprocess && result.output) {
      try {
        result.output = tool.postprocess(result.output);
      } catch {
        // Cleanup is best-effort: on failure the raw output is kept.
      }
    }
    // Central enforcement of maxOutputChars: each tool declares its own, but some paths (such as
    // extremely long single-line files) can slip through, so this is the backstop that keeps huge
    // output from blowing up the context.
    const limit = tool.maxOutputChars;
    if (limit !== undefined && result.output && result.output.length > limit) {
      const head = result.output.slice(0, Math.floor(limit * 0.7));
      const tail = result.output.slice(-Math.floor(limit * 0.25));
      return {
        ...result,
        output: `${head}\n...[truncated ${result.output.length - limit} chars]...\n${tail}`,
      };
    }
    return result;
  }
}
