import type { ToolDefinition, ToolResult } from "../types.js";
import { isAbortError } from "../utils/abort-error.js";
import type { ToolFactoryContext } from "./registry.js";
import { errorMessage, numberArg } from "./fs-helpers.js";
import {
  executeCommandWithProcessTree,
  formatPreservingTail,
  getWindowsCommandDiagnostic,
  resolveCommandCwd,
} from "./process.js";

export function registerCommandTools(
  registry: { register(tool: ToolDefinition): void },
  ctx: ToolFactoryContext,
): void {
  const { activeRoot } = ctx;
  registry.register({
    name: "run_command",
    description:
      "Run a shell command with a timeout. Prefer dedicated file/search/edit tools when they provide the needed operation. Returns stdout, stderr, and exit summary.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeout: { type: "number", description: "Timeout in seconds. Defaults to 60.", default: 60 },
        cwd: {
          type: "string",
          description:
            "Optional working directory, relative or absolute, that must remain inside the workspace root. Defaults to the workspace root.",
        },
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
          return {
            ok: false,
            output: "",
            error: "command cancelled",
            summary: "cancelled",
            metadata: { cancelled: true },
          };
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
}
