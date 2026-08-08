#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import {
  ensureUserConfig,
  loadConfig,
  loadConfigFile,
  projectConfigPath,
  resolveModelConfig,
  saveConfig,
  userConfigPath,
  userConfigReadPath,
} from "./config.js";
import { commandHelp } from "./commands.js";
import { discoverWorkspace } from "./workspace.js";
import { TerminalSession } from "./session.js";
import { SqliteTraceStore } from "./trace.js";
import { registerBuiltinTools, ToolRegistry } from "./tools.js";
import type { UserConfig } from "./types.js";
import { formatErrorDetail } from "./error-format.js";
import { CLI_NAME, ensureProjectStateRoot, PRODUCT_NAME, PROJECT_STATE_DIRECTORY, projectStateRoot, USER_DATA_DIRECTORY } from "./paths.js";

const VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version")) {
    console.log(`${PRODUCT_NAME} ${VERSION}`);
    return;
  }

  const workspace = await resolveWorkspace(valueAfter(argv, "--workspace", "-w"));
  if (!existsSync(workspace)) throw new Error(`workspace does not exist: ${workspace}`);
  await ensureProjectStateRoot(workspace);

  const command = argv[0];
  if (command === "inspect") {
    await inspectWorkspace(workspace);
    return;
  }
  if (command === "tasks") {
    listTasks(workspace, numberOption(argv, "--limit") ?? 20);
    return;
  }
  if (command === "show") {
    const taskId = firstPositional(argv.slice(1));
    if (!taskId) throw new Error(`usage: ${CLI_NAME} show TASK_ID [--workspace PATH]`);
    showTask(workspace, taskId);
    return;
  }
  if (command === "config") {
    await handleConfigCommand(argv.slice(1), workspace);
    return;
  }

  const config = await loadConfig(workspace);
  const requestedModel = valueAfter(argv, "--model", "-m");
  const approveAll = argv.includes("--approve-all") || argv.includes("-y") || config.agent?.approveAll === true;
  const prompt = command === "run" ? firstPositional(argv.slice(1)) : firstPositional(argv);

  if (prompt && command !== "tui") {
    const model = resolveModelConfig(config, requestedModel ?? config.agent?.lastModel);
    const session = new TerminalSession({ workspace, model, config, approveAll });
    const task = await session.runOnce(prompt);
    if (task.state === "failed") process.exitCode = 1;
    return;
  }

  if (command && !["tui", "run"].includes(command) && !command.startsWith("-")) {
    throw new Error(`unknown command: ${command}; use --help`);
  }

  const model = requestedModel ? resolveModelConfig(config, requestedModel) : undefined;
  const session = new TerminalSession({ workspace, ...(model ? { model } : {}), config, approveAll });
  const removeSignalHandlers = installSignalHandlers(session);
  try {
    await session.run();
  } finally {
    removeSignalHandlers();
  }
  // Interactive sessions should end the process cleanly so parent shells do not
  // treat residual Ctrl+C delivery as an unfinished batch job.
  if (process.exitCode === undefined) process.exitCode = 0;
}

function installSignalHandlers(session: TerminalSession): () => void {
  const cancel = (): void => session.cancel();
  process.on("SIGINT", cancel);
  return () => process.off("SIGINT", cancel);
}

function firstPositional(args: readonly string[]): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (["--model", "-m", "--workspace", "-w"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--approve-all" || arg === "-y") continue;
    if (arg.startsWith("-")) continue;
    values.push(arg);
  }
  return values.length ? values.join(" ") : undefined;
}

function valueAfter(args: readonly string[], ...names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  return index >= 0 ? args[index + 1] : undefined;
}

export function resolveWorkspace(requested: string | undefined): string {
  if (requested) return resolve(requested);
  return resolve(process.env.INIT_CWD ?? process.cwd());
}

async function inspectWorkspace(workspace: string): Promise<void> {
  const snapshot = await discoverWorkspace(workspace);
  console.log(snapshot.summary);
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, workspace);
  console.log("\nTools:");
  for (const schema of registry.schemas()) {
    const name = String((schema.function as { name?: unknown }).name ?? "unknown");
    console.log(`- ${name} (L${registry.get(name).permissionLevel})`);
  }
}

function listTasks(workspace: string, limit: number): void {
  const path = resolve(projectStateRoot(workspace), "trace.db");
  if (!existsSync(path)) {
    console.log(`No task trace at ${path}`);
    return;
  }
  const trace = new SqliteTraceStore(path, workspace);
  try {
    for (const task of trace.listTasks(Math.max(1, limit))) {
      console.log(`${task.id}  ${task.state.padEnd(16)} ${task.updatedAt.slice(0, 19)}`);
      console.log(`  ${task.prompt.slice(0, 120)}`);
    }
  } finally {
    trace.close();
  }
}

function showTask(workspace: string, taskId: string): void {
  const path = resolve(projectStateRoot(workspace), "trace.db");
  if (!existsSync(path)) throw new Error(`no task trace at ${path}`);
  const trace = new SqliteTraceStore(path, workspace);
  try {
    console.log(JSON.stringify(trace.exportTrace(taskId), null, 2));
  } finally {
    trace.close();
  }
}

async function handleConfigCommand(args: readonly string[], workspace: string): Promise<void> {
  const action = args[0] ?? "get";
  const project = args.includes("--project");
  if (!project) await ensureUserConfig();
  const path = project ? projectConfigPath(workspace) : userConfigPath();
  const readPath = project ? path : userConfigReadPath();
  if (action === "get") {
    await printConfigFile(readPath, args.includes("--show-secrets"), project ? undefined : path);
    return;
  }
  if (action === "migrate") {
    const config = await loadConfigFile(readPath);
    await saveConfig(config, path);
    console.log(`Configuration migrated to ${path}`);
    return;
  }
  if (action === "set") {
    const key = args[1];
    const rawValue = args[2];
    if (!key || rawValue === undefined) throw new Error(`usage: ${CLI_NAME} config set KEY VALUE`);
    const config = await loadConfigFile(readPath);
    setConfigValue(config, key, rawValue);
    await saveConfig(config, path);
    console.log(`${key} saved to ${path}`);
    return;
  }
  if (action === "unset") {
    const key = args[1];
    if (!key) throw new Error(`usage: ${CLI_NAME} config unset KEY`);
    const config = await loadConfigFile(readPath);
    unsetConfigValue(config, key);
    await saveConfig(config, path);
    console.log(`${key} removed from ${path}`);
    return;
  }
  throw new Error(`unknown config action: ${action}; use get, set, or unset`);
}

async function printConfigFile(path: string, showSecrets: boolean, primaryPath?: string): Promise<void> {
  if (!existsSync(path)) {
    console.log(`No config at ${primaryPath ?? path}`);
    return;
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const source = primaryPath && path !== primaryPath ? ` (loaded from legacy path: ${path})` : "";
  console.log(`Config: ${primaryPath ?? path}${source}`);
  console.log(JSON.stringify(showSecrets ? parsed : maskSecrets(parsed), null, 2));
}

function maskSecrets(value: unknown, key?: string): unknown {
  if (key === "api_key" || key === "apiKey") {
    if (typeof value !== "string") return value;
    return value.length > 6 ? `${value.slice(0, 3)}...${value.slice(-3)}` : "***";
  }
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskSecrets(item, name)]));
  }
  return value;
}

function setConfigValue(config: UserConfig, key: string, rawValue: string): void {
  switch (key) {
    case "agent.approveAll":
    case "agent.skipVerify": {
      const value = parseBoolean(rawValue);
      config.agent = { ...config.agent, [key === "agent.approveAll" ? "approveAll" : "skipVerify"]: value };
      return;
    }
    case "agent.maxSteps": {
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value <= 0) throw new Error("agent.maxSteps must be a positive integer");
      config.agent = { ...config.agent, maxSteps: value };
      return;
    }
    case "agent.tokenBudget": {
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 0) throw new Error("agent.tokenBudget must be a non-negative integer");
      config.agent = { ...config.agent, tokenBudget: value };
      return;
    }
    case "sessionTitles.mode": {
      if (rawValue !== "first-message" && rawValue !== "local" && rawValue !== "model") {
        throw new Error("sessionTitles.mode must be first-message, local, or model");
      }
      config.sessionTitles = { ...config.sessionTitles, mode: rawValue };
      return;
    }
    case "sessionTitles.model": {
      const value = rawValue.trim();
      if (!value) throw new Error("sessionTitles.model must be a provider/model reference");
      config.sessionTitles = { ...config.sessionTitles, model: value };
      return;
    }
    default:
      throw new Error(`unknown config key: ${key}`);
  }
}

function unsetConfigValue(config: UserConfig, key: string): void {
  if (key === "agent.approveAll") delete config.agent?.approveAll;
  else if (key === "agent.skipVerify") delete config.agent?.skipVerify;
  else if (key === "agent.maxSteps") delete config.agent?.maxSteps;
  else if (key === "agent.tokenBudget") delete config.agent?.tokenBudget;
  else if (key === "sessionTitles.mode") delete config.sessionTitles?.mode;
  else if (key === "sessionTitles.model") delete config.sessionTitles?.model;
  else throw new Error(`unknown config key: ${key}`);
  if (config.agent && Object.keys(config.agent).length === 0) delete config.agent;
  if (config.sessionTitles && Object.keys(config.sessionTitles).length === 0) delete config.sessionTitles;
}

function parseBoolean(value: string): boolean {
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`invalid boolean: ${value} (use true or false)`);
}

function numberOption(args: readonly string[], name: string): number | undefined {
  const raw = valueAfter(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

export function printHelp(): void {
  console.log(`${PRODUCT_NAME} ${VERSION}

Usage:
  oran                              start an interactive session
  oran tui                          start an interactive session
  oran run "inspect project"        run one task without the prompt loop
  oran inspect                       inspect the active workspace and tools
  oran tasks                         list persisted task traces
  oran show TASK_ID                  show one persisted task trace
  oran config get                    show the user config
  oran config migrate                rewrite legacy config in canonical shape
  oran config set KEY VALUE          persist an agent or session-title setting
  oran config unset KEY              remove an agent or session-title setting
  oran --model provider/model       choose the configured model
  oran --workspace PATH             choose the active workspace
  oran --approve-all                skip tool approvals

Configuration:
  ~/${USER_DATA_DIRECTORY}/config.json             user model/provider catalog
  <workspace>/${PROJECT_STATE_DIRECTORY}/config.json project overrides
  (the most recently used model is restored automatically)

Interactive commands:
${commandHelp()}
  !command                         run a shell command in the workspace

Launch tip (Windows):
  Launch interactive sessions without a .cmd wrapper so Ctrl+C stays inside ${PRODUCT_NAME}:
    node dev.mjs
  or run the TypeScript entry directly:
    node --import ./packages/oran-code/node_modules/tsx/dist/loader.mjs packages/oran-code/src/cli.ts
  or after build:
    node packages/oran-code/dist/cli.js
  Do not use pnpm.cmd dev for an interactive session; cmd.exe may show its batch-job prompt.

`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    await main(argv);
  } catch (error: unknown) {
    console.error(formatErrorDetail(error, { includeStack: true }));
    process.exitCode = 1;
  }
}

// 兼容 npm/pnpm 全局 link 的软链入口：realpath 双向比较。
if (process.argv[1]) {
  try {
    const entryReal = realpathSync(process.argv[1]);
    const selfReal = realpathSync(fileURLToPath(import.meta.url));
    if (entryReal === selfReal || pathToFileURL(entryReal).href === import.meta.url) {
      void runCli();
    }
  } catch {
    // 入口缺失时 realpath 可能抛错，不应阻断 CLI 启动。
  }
}
