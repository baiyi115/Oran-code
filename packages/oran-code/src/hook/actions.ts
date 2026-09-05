import type { HookAction, HookEngineDeps, HookEventContext, HookResult } from "./types.js";

export function buildHookEnv(action: HookAction, ctx: HookEventContext): Record<string, string> {
  const env: Record<string, string> = {
    HOOK_EVENT: ctx.event,
    HOOK_TOOL: ctx.tool?.name ?? "",
    HOOK_FILE_PATH: ctx.filePath ?? "",
  };
  return env;
}

export async function executeAction(
  action: HookAction,
  ctx: HookEventContext,
  deps: HookEngineDeps,
  defaultTimeoutMs: number,
  intercept: boolean,
): Promise<HookResult> {
  try {
    switch (action.type) {
      case "command":
        return await executeCommand(action, ctx, deps, defaultTimeoutMs, intercept);
      case "prompt":
        return executePrompt(action, intercept);
      case "http":
        return await executeHttp(action, ctx, deps, defaultTimeoutMs, intercept);
      case "subagent":
        return await executeSubAgent(action, ctx, deps, intercept);
      default:
        return { output: `unknown action type: ${action.type}`, ok: false, intercept };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: errorPrefix(message), ok: false, intercept };
  }
}

async function executeCommand(
  action: HookAction,
  ctx: HookEventContext,
  deps: HookEngineDeps,
  defaultTimeoutMs: number,
  intercept: boolean,
): Promise<HookResult> {
  const command = action.command?.trim();
  if (!command) return { output: errorPrefix("command action requires a non-empty command"), ok: false, intercept };
  const env = buildHookEnv(action, ctx);
  const timeoutMs = action.timeoutMs ?? defaultTimeoutMs;
  const { ok, stdout } = await deps.runCommand(command, env, timeoutMs);
  return { output: stdout.trimEnd(), ok, intercept };
}

function executePrompt(action: HookAction, intercept: boolean): HookResult {
  const prompt = action.prompt?.trim();
  if (!prompt) return { output: errorPrefix("prompt action requires a non-empty prompt"), ok: false, intercept };
  return { output: prompt, ok: true, intercept };
}

async function executeHttp(
  action: HookAction,
  ctx: HookEventContext,
  deps: HookEngineDeps,
  defaultTimeoutMs: number,
  intercept: boolean,
): Promise<HookResult> {
  const url = action.url?.trim();
  if (!url) return { output: errorPrefix("http action requires a non-empty url"), ok: false, intercept };
  const method = (action.method ?? "POST").toUpperCase();
  const messages = deps.sessionMessages?.() ?? [];
  const bodyContext = {
    event: ctx.event,
    tool: ctx.tool ? { name: ctx.tool.name, arguments: ctx.tool.arguments } : undefined,
    filePath: ctx.filePath,
    userPrompt: ctx.userPrompt,
    assistantText: ctx.assistantText,
    workspace: ctx.workspace,
    model: ctx.model,
    messages,
  };
  const body = JSON.stringify(bodyContext);
  const headers: Record<string, string> = { "content-type": "application/json", ...(action.headers ?? {}) };
  // 不带超时的 fetch 会永久阻塞 agent 循环(端点挂起不响应);超时由 deps.fetch
  // 以 { ok:false, status:0 } 形式返回。
  const timeoutMs = action.timeoutMs ?? defaultTimeoutMs;
  const { ok, status, body: responseBody } = await deps.fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const output = status >= 200 && status < 300 ? responseBody : `HTTP ${status}: ${responseBody}`;
  return { output, ok: ok && status >= 200 && status < 300, intercept };
}

async function executeSubAgent(
  action: HookAction,
  ctx: HookEventContext,
  deps: HookEngineDeps,
  intercept: boolean,
): Promise<HookResult> {
  const prompt = action.prompt?.trim();
  const command = action.command?.trim();
  if (!prompt && !command) {
    return { output: errorPrefix("subagent action requires a non-empty prompt or command"), ok: false, intercept };
  }
  if (!deps.subAgentExecutor) {
    return { output: errorPrefix("subagent executor not registered"), ok: false, intercept };
  }
  const result = await deps.subAgentExecutor(prompt ?? command ?? "", ctx);
  return { ...result, intercept };
}

export function errorPrefix(message: string): string {
  return `[hook error] ${message}`;
}

export function asyncErrorText(message: string): string {
  return `[hook async error] ${message}`;
}
