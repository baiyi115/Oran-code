import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { HookConfig, HookEngineDeps, HookSubAgentExecutor, HookValidationError } from "./types.js";
import { HookEngine, type HookEngineOptions } from "./engine.js";
import { HookNoticeQueue } from "./notify-queue.js";
import { userConfigPath } from "../config.js";
import { projectStateRoot } from "../paths.js";

const execAsync = promisify(exec);

export interface HooksConfigSlice {
  hooks?: unknown;
}

export function extractHooks(value: unknown): HookConfig[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  const raw = root.hooks;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeHookConfig);
}

function invalidHookConfig(): HookConfig {
  return { event: "" as HookConfig["event"], action: { type: "" as HookConfig["action"]["type"] } };
}

function normalizeHookConfig(value: unknown): HookConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidHookConfig();
  const item = value as Record<string, unknown>;
  const actionRaw = item.action;
  if (!actionRaw || typeof actionRaw !== "object" || Array.isArray(actionRaw)) return invalidHookConfig();
  const action = actionRaw as Record<string, unknown>;
  const config: HookConfig = {
    event: typeof item.event === "string" ? (item.event as HookConfig["event"]) : ("" as HookConfig["event"]),
    action: {
      type: (typeof action.type === "string" ? action.type : "") as HookConfig["action"]["type"],
      ...(typeof action.command === "string" ? { command: action.command } : {}),
      ...(typeof action.prompt === "string" ? { prompt: action.prompt } : {}),
      ...(typeof action.url === "string" ? { url: action.url } : {}),
      ...(typeof action.method === "string" ? { method: action.method } : {}),
      ...(action.headers && typeof action.headers === "object" && !Array.isArray(action.headers)
        ? { headers: action.headers as Record<string, string> }
        : {}),
      ...(typeof action.timeoutMs === "number" ? { timeoutMs: action.timeoutMs } : {}),
    },
  };
  if (typeof item.id === "string" && item.id.trim()) config.id = item.id;
  if (typeof item.if === "string" && item.if.trim()) config.if = item.if;
  if (item.intercept === true) config.intercept = true;
  if (item.once === true) config.once = true;
  if (item.async === true) config.async = true;
  if (item.onError === "ignore" || item.onError === "fail" || item.onError === "reject") config.onError = item.onError;
  return config;
}

export async function loadAllHooks(workspace: string): Promise<{ configs: HookConfig[]; loadErrors: string[] }> {
  const collected: HookConfig[] = [];
  const loadErrors: string[] = [];

  collected.push(...(await loadHooksFromJsonFile(userConfigPath(), loadErrors)));

  const projectJson = resolve(projectStateRoot(workspace), "config.json");
  collected.push(...(await loadHooksFromJsonFile(projectJson, loadErrors)));

  const projectYaml = resolve(projectStateRoot(workspace), "hooks.local.yaml");
  collected.push(...(await loadHooksFromYamlFile(projectYaml, loadErrors)));

  return { configs: collected, loadErrors };
}

async function loadHooksFromJsonFile(path: string, errors: string[]): Promise<HookConfig[]> {
  if (!existsSync(path)) return [];
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    return extractHooks(parsed);
  } catch (error) {
    errors.push(`hooks JSON load failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function loadHooksFromYamlFile(path: string, errors: string[]): Promise<HookConfig[]> {
  if (!existsSync(path)) return [];
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = parse(text);
    return extractHooks(parsed);
  } catch (error) {
    errors.push(`hooks YAML load failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function createHookEngineDeps(options: {
  notices: HookNoticeQueue;
  log?: (message: string) => void;
  workspace: string;
  subAgentExecutor?: HookSubAgentExecutor;
  sessionMessages?: HookEngineDeps["sessionMessages"];
}): HookEngineDeps {
  const deps: HookEngineDeps = {
    notices: options.notices,
    runCommand: async (command, env, timeoutMs) => {
      try {
        const merged = { ...process.env, ...env };
        const resolvedTimeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;
        const { stdout } = await execAsync(command, {
          cwd: options.workspace,
          env: merged,
          ...(resolvedTimeout !== undefined ? { timeout: resolvedTimeout } : {}),
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });
        return { ok: true, stdout };
      } catch (error) {
        const e = error as { stdout?: Buffer; message?: string };
        const stdout = e.stdout ? (typeof e.stdout === "string" ? e.stdout : e.stdout.toString("utf8")) : "";
        return { ok: false, stdout: stdout || (e.message ?? "command failed") };
      }
    },
    fetch: async (url, init) => {
      try {
        const requestInit: Record<string, unknown> = { method: init.method };
        if (init.headers) requestInit.headers = init.headers;
        if (init.body !== undefined) requestInit.body = init.body;
        const response = await (
          globalThis as unknown as {
            fetch: (
              input: string,
              init?: Record<string, unknown>,
            ) => Promise<{
              ok: boolean;
              status: number;
              text: () => Promise<string>;
            }>;
          }
        ).fetch(url, requestInit);
        const body = await response.text();
        return { ok: response.ok, status: response.status, body };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 0, body: message };
      }
    },
  };
  if (options.log) deps.log = options.log;
  if (options.subAgentExecutor) deps.subAgentExecutor = options.subAgentExecutor;
  if (options.sessionMessages) deps.sessionMessages = options.sessionMessages;
  return deps;
}

export async function createHookEngine(
  workspace: string,
  options: {
    defaultCommandTimeoutMs: number;
    log?: (message: string) => void;
    subAgentExecutor?: HookSubAgentExecutor;
    sessionMessages?: HookEngineDeps["sessionMessages"];
  },
): Promise<{ engine: HookEngine; notices: HookNoticeQueue; errors: readonly HookValidationError[] }> {
  const notices = new HookNoticeQueue();
  const depsOptions: {
    notices: HookNoticeQueue;
    workspace: string;
    log?: (message: string) => void;
    subAgentExecutor?: HookSubAgentExecutor;
    sessionMessages?: HookEngineDeps["sessionMessages"];
  } = { notices, workspace };
  if (options.log) depsOptions.log = options.log;
  if (options.subAgentExecutor) depsOptions.subAgentExecutor = options.subAgentExecutor;
  if (options.sessionMessages) depsOptions.sessionMessages = options.sessionMessages;
  const deps = createHookEngineDeps(depsOptions);
  const { configs, loadErrors } = await loadAllHooks(workspace);
  const engine = new HookEngine(configs, {
    ...deps,
    defaultCommandTimeoutMs: options.defaultCommandTimeoutMs,
  });
  const validationErrors = engine.getErrors();
  const loadValidationErrors: HookValidationError[] = loadErrors.map((message, index) => ({
    index: -1 - index,
    message,
  }));
  return { engine, notices, errors: [...loadValidationErrors, ...validationErrors] };
}

export type { HookEngineOptions };
