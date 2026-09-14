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
import type { Task, UserConfig } from "./types.js";
import type { JsonlEventLog } from "./headless-events.js";
import { formatErrorDetail } from "./error-format.js";
import {
  CLI_NAME,
  ensureProjectStateRoot,
  PRODUCT_NAME,
  PROJECT_STATE_DIRECTORY,
  projectStateRoot,
  USER_DATA_DIRECTORY,
} from "./paths.js";

const VERSION = "0.1.0";

// Node 24 emits `ExperimentalWarning: SQLite is an experimental feature...` the
// first time `node:sqlite` loads (trace store). Swallow exactly that warning so
// it doesn't pollute the TUI, while every other warning passes through unchanged.
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const type =
    typeof rest[0] === "string"
      ? rest[0]
      : ((rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined));
  const message = typeof warning === "string" ? warning : (warning as Error | undefined)?.message;
  if (type === "ExperimentalWarning" && typeof message === "string" && message.includes("SQLite")) return;
  return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    await printHelp();
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
    await listTasks(workspace, numberOption(argv, "--limit") ?? 20);
    return;
  }
  if (command === "show") {
    const taskId = firstPositional(argv.slice(1));
    if (!taskId) throw new Error(`usage: ${CLI_NAME} show TASK_ID [--workspace PATH]`);
    await showTask(workspace, taskId);
    return;
  }
  if (command === "config") {
    await handleConfigCommand(argv.slice(1), workspace);
    return;
  }
  if (command && !["tui", "run", "code"].includes(command) && !command.startsWith("-")) {
    throw new Error(`unknown command: ${command}; use --help`);
  }

  const config = await loadConfig(workspace);
  const requestedModel = valueAfter(argv, "--model", "-m");
  const approveAll = argv.includes("--approve-all") || argv.includes("-y") || config.agent?.approveAll === true;
  const acceptEdits = argv.includes("--accept-edits") || argv.includes("-a");
  const requestedPermissionMode = approveAll ? "bypass" : acceptEdits ? "accept-edits" : undefined;
  const outputPath = valueAfter(argv, "--output", "-o");
  const taskFile = valueAfter(argv, "--task");
  const timeoutSeconds = secondsOption(argv, "--timeout");
  const prompt =
    command === "run" ? (taskFile ? await readTaskFile(taskFile) : firstPositional(argv.slice(1))) : undefined;

  if (command !== "run" && (outputPath || taskFile || timeoutSeconds !== undefined)) {
    throw new UsageError("--output, --task and --timeout are only supported by the run command");
  }
  if (command === "run" && !prompt) {
    throw new UsageError(`usage: ${CLI_NAME} run "..." [--workspace PATH] [--output FILE.jsonl] [--timeout SECONDS]`);
  }
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
    throw new UsageError("--timeout must be a positive number of seconds");
  }
  if (prompt) {
    const model = resolveModelConfig(config, requestedModel ?? config.agent?.lastModel);
    const eventLog = outputPath
      ? await openEventLog(outputPath, {
          model: `${model.provider}/${model.model}`,
          workspace,
          prompt,
        })
      : undefined;
    const { TerminalSession } = await import("./session.js");
    const session = new TerminalSession({
      workspace,
      model,
      config,
      approveAll,
      ...(requestedPermissionMode ? { permissionMode: requestedPermissionMode } : {}),
      ...(eventLog ? { runtimeEventSink: (event) => eventLog.record(event) } : {}),
    });
    const startedAt = Date.now();
    const outcome = await runScripted(session, prompt, timeoutSeconds ? timeoutSeconds * 1000 : undefined);
    const exitCode = EXIT_CODES[outcome.outcome];
    if (eventLog) {
      await eventLog.finish({
        outcome: outcome.outcome,
        exitCode,
        durationMs: Date.now() - startedAt,
        finalText: outcome.task?.result ?? "",
        ...(outcome.error ? { error: withoutStack(outcome.error) } : {}),
      });
      if (eventLog.writeFailure) {
        console.error(
          `warning: could not write the event log at ${eventLog.outputPath}: ${eventLog.writeFailure.message}`,
        );
      }
      console.error(`${CLI_NAME}: ${outcome.outcome} -> ${eventLog.outputPath}`);
    }
    if (outcome.error) console.error(outcome.error);
    process.exitCode = exitCode;
    return;
  }

  const model = requestedModel ? resolveModelConfig(config, requestedModel) : undefined;
  const { TerminalSession } = await import("./session.js");
  const session = new TerminalSession({
    workspace,
    ...(model ? { model } : {}),
    config,
    approveAll,
    ...(requestedPermissionMode ? { permissionMode: requestedPermissionMode } : {}),
  });
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

function installSignalHandlers(session: { cancel(): void }): () => void {
  const cancel = (): void => session.cancel();
  process.on("SIGINT", cancel);
  return () => process.off("SIGINT", cancel);
}

/** Invalid command-line usage; reported without a stack trace and exits with code 2. */
export class UsageError extends Error {}

/** Process exit codes for scripted runs; the JSONL `run_end` record repeats them. */
export const EXIT_CODES = {
  completed: 0,
  failed: 1,
  timeout: 3,
  cancelled: 4,
} as const;

interface ScriptedSession {
  runOnce(prompt: string): Promise<Task>;
  cancel(): void;
}

type ScriptedOutcome = {
  outcome: keyof typeof EXIT_CODES;
  task?: Task;
  error?: string;
};

/**
 * Runs one prompt without the interactive loop and classifies the result.
 * A CLI-level `--timeout` cancels the running task; the harness may also apply
 * its own timeout, in which case the JSONL `run_end` record is authoritative.
 */
async function runScripted(
  session: ScriptedSession,
  prompt: string,
  timeoutMs: number | undefined,
): Promise<ScriptedOutcome> {
  const attempt = session.runOnce(prompt).then(
    (task): ScriptedOutcome => ({ outcome: outcomeForState(task.state), task }),
    (error: unknown): ScriptedOutcome => ({
      outcome: "failed",
      error: formatErrorDetail(error, { includeStack: true }),
    }),
  );
  if (!timeoutMs) return attempt;

  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const deadline = new Promise<ScriptedOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      session.cancel();
      // Cancel unwinds the loop asynchronously; give it a bounded window so
      // trace/session state and MCP child processes are torn down cleanly.
      graceTimer = setTimeout(() => resolve({ outcome: "timeout" }), CANCEL_GRACE_MS);
    }, timeoutMs);
  });
  try {
    const settled = await Promise.race([attempt, deadline]);
    // A run cancelled because of --timeout is reported as a timeout even when
    // the session settles first, so the outcome never depends on a race.
    return timedOut ? { outcome: "timeout", ...(settled.task ? { task: settled.task } : {}) } : settled;
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

/** How long a `--timeout` cancellation may take to unwind before reporting. */
const CANCEL_GRACE_MS = 3_000;

function outcomeForState(state: Task["state"]): keyof typeof EXIT_CODES {
  if (state === "completed") return "completed";
  if (state === "cancelled") return "cancelled";
  return "failed";
}

/** Reads a positive seconds option, reporting invalid values as usage errors. */
function secondsOption(args: readonly string[], name: string): number | undefined {
  const raw = valueAfter(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${name} must be a number of seconds`);
  return value;
}

async function readTaskFile(path: string): Promise<string> {
  const target = resolve(path);
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read --task file ${target}: ${(error as Error).message}`);
  }
  const prompt = content.trim();
  if (!prompt) throw new UsageError(`--task file is empty: ${target}`);
  return prompt;
}

/** Drops the appended stack trace; stderr keeps the full detail for debugging. */
function withoutStack(detail: string): string {
  const marker = detail.indexOf("\nstack:");
  return marker === -1 ? detail : detail.slice(0, marker);
}

async function openEventLog(
  path: string,
  header: { model: string; workspace: string; prompt: string },
): Promise<JsonlEventLog> {
  const { JsonlEventLog } = await import("./headless-events.js");
  try {
    return JsonlEventLog.open(path, { ...header, productVersion: VERSION });
  } catch (error) {
    throw new UsageError(`cannot write --output log at ${resolve(path)}: ${(error as Error).message}`);
  }
}

function firstPositional(args: readonly string[]): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (["--model", "-m", "--workspace", "-w", "--output", "-o", "--task", "--timeout"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--approve-all" || arg === "-y") continue;
    if (arg === "--accept-edits" || arg === "-a") continue;
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
  // The process cwd is the user's invocation directory. INIT_CWD can be
  // inherited from a package-manager process that launched the CLI and may
  // point at Oran's source/install directory instead of the target project.
  return resolve(process.cwd());
}

async function inspectWorkspace(workspace: string): Promise<void> {
  const [{ discoverWorkspace }, { registerBuiltinTools, ToolRegistry }] = await Promise.all([
    import("./workspace.js"),
    import("./tools.js"),
  ]);
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

async function listTasks(workspace: string, limit: number): Promise<void> {
  const path = resolve(projectStateRoot(workspace), "trace.db");
  if (!existsSync(path)) {
    console.log(`No task trace at ${path}`);
    return;
  }
  const { SqliteTraceStore } = await import("./trace.js");
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

async function showTask(workspace: string, taskId: string): Promise<void> {
  const path = resolve(projectStateRoot(workspace), "trace.db");
  if (!existsSync(path)) throw new Error(`no task trace at ${path}`);
  const { SqliteTraceStore } = await import("./trace.js");
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

const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password|authorization|credential/i;

function maskSecrets(value: unknown, key?: string): unknown {
  // 除 apiKey 外,mcpServers.*.env / headers 等任意命中敏感键名的字符串值
  // 一并掩码,避免凭据经 `oran config get` 进入终端或日志。
  if (key && SECRET_KEY_PATTERN.test(key)) {
    if (typeof value !== "string") return "***";
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

export async function printHelp(): Promise<void> {
  const { commandHelp } = await import("./commands.js");
  console.log(`${PRODUCT_NAME} ${VERSION}

Usage:
  oran                              start an interactive session
  oran code                         start an interactive session (alias)
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
  oran --accept-edits, -a           auto-apply file edits (only confirm shell commands)
  oran --approve-all, -y            skip all tool approvals (bypass mode)

Scripted runs (oran run):
  --task FILE                       read the prompt from a file instead of argv
  --output FILE.jsonl, -o           write one JSON event per line (see evals/README.md)
  --timeout SECONDS                 cancel the run and exit 3 when it exceeds the limit
  exit codes                        0 completed, 1 failed, 2 invalid usage,
                                    3 timeout, 4 cancelled

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
    if (error instanceof UsageError) {
      console.error(`${CLI_NAME}: ${error.message}`);
      process.exitCode = 2;
      return;
    }
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
