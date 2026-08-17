import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { ContentBlock, Tool, Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig, ToolDefinition, ToolResult } from "../types.js";

const MCP_TOOL_PREFIX = "mcp__";
const MCP_SEARCH_TOOL = "mcp_search_tools";
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_TOOL_OUTPUT = 32_000;
const MCP_CONNECTION_CONCURRENCY = 3;

export interface McpToolInfo {
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface McpServerStatus {
  readonly name: string;
  readonly toolCount: number;
}

export interface McpFailure {
  readonly name: string;
  readonly error: string;
}

export interface McpInstruction {
  readonly server: string;
  readonly text: string;
}

interface ConnectedMcpServer {
  readonly name: string;
  readonly client: Client;
  readonly transport: Transport;
  readonly tools: readonly Tool[];
  readonly instructions?: string;
}

interface RegisteredMcpTool extends McpToolInfo {
  readonly client: Client;
  readonly remote: Tool;
}

export class McpManager {
  private readonly config: Readonly<Record<string, McpServerConfig>>;
  private readonly workspace: string;
  private readonly servers = new Map<string, ConnectedMcpServer>();
  private readonly pendingClients = new Set<Client>();
  private readonly tools = new Map<string, RegisteredMcpTool>();
  private readonly activated = new Set<string>();
  private readonly connectionFailures: McpFailure[] = [];
  private connectPromise: Promise<void> | undefined;
  private closed = false;

  constructor(config: Readonly<Record<string, McpServerConfig>>, workspace: string) {
    this.config = config;
    this.workspace = workspace;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectAll();
    return this.connectPromise;
  }

  async whenReady(): Promise<void> {
    await this.connect();
  }

  listTools(): readonly McpToolInfo[] {
    return [...this.tools.values()].map(({ client: _client, remote: _remote, ...tool }) => tool);
  }

  toolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      permissionLevel: 3,
      kind: "command",
      maxOutputChars: MAX_TOOL_OUTPUT,
      invoke: async (call, context) => {
        try {
          const result = await tool.client.callTool(
            { name: tool.tool, arguments: call.arguments },
            context?.signal ? { signal: context.signal, toolDefinition: tool.remote } : { toolDefinition: tool.remote },
          );
          const output = formatContent(result.content);
          if (result.isError === true) {
            return {
              ok: false,
              output,
              error: output || `MCP tool ${tool.name} returned an error`,
              summary: "error",
            };
          }
          return { ok: true, output, summary: `called ${tool.name}` };
        } catch (error) {
          return failedToolResult(error);
        }
      },
    }));
  }

  searchToolDefinition(): ToolDefinition {
    return {
      name: MCP_SEARCH_TOOL,
      description: "Search inactive MCP tools by keyword. Use query select:<full-tool-name> to activate one tool and return its schema.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, or select:mcp__server__tool for exact activation." },
          limit: { type: "integer", description: `Maximum search results, default ${DEFAULT_SEARCH_LIMIT}.` },
        },
        required: ["query"],
      },
      permissionLevel: 0,
      system: true,
      kind: "readonly",
      maxOutputChars: MAX_TOOL_OUTPUT,
      invoke: async (call) => this.searchTools(call.arguments.query, call.arguments.limit),
    };
  }

  activate(name: string): McpToolInfo | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    this.activated.add(name);
    const { client: _client, remote: _remote, ...info } = tool;
    return info;
  }

  isActivated(name: string): boolean {
    return this.activated.has(name);
  }

  isMcpTool(name: string): boolean {
    return this.tools.has(name);
  }

  connectedServers(): readonly McpServerStatus[] {
    return [...this.servers.values()].map((server) => ({ name: server.name, toolCount: server.tools.length }));
  }

  get toolCount(): number {
    return this.tools.size;
  }

  failures(): readonly McpFailure[] {
    return [...this.connectionFailures];
  }

  instructions(): readonly McpInstruction[] {
    return [...this.servers.values()]
      .filter((server): server is ConnectedMcpServer & { instructions: string } => Boolean(server.instructions?.trim()))
      .map((server) => ({ server: server.name, text: server.instructions.trim() }));
  }

  discoveryReminder(): string | undefined {
    const names = [...this.tools.keys()].filter((name) => !this.activated.has(name));
    if (!names.length) return undefined;
    return `${names.length} inactive MCP tool(s) are available. Use mcp_search_tools with keywords to discover them, then use select:<full-tool-name> to activate one.`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connectPromise?.catch(() => undefined);
    const clients = new Set([
      ...this.pendingClients,
      ...[...this.servers.values()].map((server) => server.client),
    ]);
    await Promise.allSettled([...clients].map((client) => client.close()));
    this.pendingClients.clear();
    this.servers.clear();
    this.tools.clear();
    this.connectPromise = undefined;
  }

  private async connectAll(): Promise<void> {
    if (this.closed) return;
    const entries = Object.entries(this.config);
    for (let offset = 0; offset < entries.length; offset += MCP_CONNECTION_CONCURRENCY) {
      if (this.closed) break;
      await Promise.all(entries.slice(offset, offset + MCP_CONNECTION_CONCURRENCY)
        .map(([name, config]) => this.connectServer(name, config)));
    }
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.closed) return;
    let client: Client | undefined;
    try {
      const transport = createTransport(config, this.workspace);
      client = new Client({ name: "oran-code", version: "0.1.0" });
      this.pendingClients.add(client);
      await client.connect(transport);
      const listed = await client.listTools();
      const instructions = client.getInstructions()?.trim();
      const server: ConnectedMcpServer = {
        name,
        client,
        transport,
        tools: listed.tools,
        ...(instructions ? { instructions } : {}),
      };
      this.pendingClients.delete(client);
      this.servers.set(name, server);
      for (const remote of listed.tools) {
        const fullName = `${MCP_TOOL_PREFIX}${sanitizeName(name)}__${sanitizeName(remote.name)}`;
        this.tools.set(fullName, {
          name: fullName,
          server: name,
          tool: remote.name,
          description: remote.description ?? "",
          parameters: remote.inputSchema as Record<string, unknown>,
          client,
          remote,
        });
      }
    } catch (error) {
      if (client) this.pendingClients.delete(client);
      this.connectionFailures.push({ name, error: errorMessage(error) });
      await client?.close().catch(() => undefined);
    }
  }

  private async searchTools(rawQuery: unknown, rawLimit: unknown): Promise<ToolResult> {
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query) return { ok: false, output: "", error: "query is required", summary: "invalid MCP search" };

    if (query.toLowerCase().startsWith("select:")) {
      const name = query.slice("select:".length).trim();
      const tool = this.activate(name);
      if (!tool) {
        return { ok: false, output: "", error: `MCP tool not found: ${name}`, summary: "MCP tool not found" };
      }
      return {
        ok: true,
        output: JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2),
        summary: `activated ${tool.name}`,
      };
    }

    const limit = searchLimit(rawLimit);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [...this.tools.values()]
      .filter((tool) => !this.activated.has(tool.name))
      .filter((tool) => {
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .slice(0, limit)
      .map((tool) => ({ name: tool.name, description: tool.description }));
    return {
      ok: true,
      output: matches.length ? JSON.stringify(matches, null, 2) : "No inactive MCP tools matched the query.",
      summary: `${matches.length} MCP tools found`,
    };
  }
}

function createTransport(config: McpServerConfig, workspace: string): Transport {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      env: { ...inheritedEnvironment(), ...expandValues(config.env) },
      stderr: "ignore",
      cwd: workspace,
    });
  }
  if (!config.url) throw new Error("server must define command or url");
  const url = new URL(config.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported MCP URL protocol: ${url.protocol}`);
  }
  const headers = expandValues(config.headers);
  if (config.transport === "sse") {
    return Object.keys(headers).length
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new SSEClientTransport(url);
  }
  return Object.keys(headers).length
    ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url);
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function expandValues(values: Record<string, string> | undefined): Record<string, string> {
  if (!values) return {};
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandEnvironment(value)]));
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function formatContent(content: readonly ContentBlock[]): string {
  return content.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
}

function searchLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value)
      : DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function failedToolResult(error: unknown): ToolResult {
  return { ok: false, output: "", error: errorMessage(error), summary: "error" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
