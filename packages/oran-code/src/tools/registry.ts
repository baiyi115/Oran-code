import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from "../types.js";

/** 内置工具注册的共享上下文：供各工具族注册函数使用（模式与 registerWorktreeTools 的注入一致）。 */
export interface ToolFactoryContext {
  /** 工作区根目录（绝对路径）。 */
  readonly root: string;
  /** 计划目录相对 workspace 的展示路径（write_plan 描述使用）。 */
  readonly planDirectory: string;
  /** 当前生效的 workspace 根：优先取执行上下文，缺省回退 root。 */
  activeRoot(context?: ToolExecutionContext): string;
  /** 解析 workspace 相对路径，越界即抛错。 */
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
    // 中央执行 maxOutputChars:工具各自声明,但个别路径(如超长单行文件)
    // 可能漏截,这里兜底,避免超大输出挤爆上下文。
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
