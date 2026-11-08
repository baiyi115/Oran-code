import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ModelConfig, PermissionConfig, PermissionMode, RuntimeConfig, UserConfig, WorkMode } from "./types.js";
import { compatibleUserDataPath, projectStateRoot } from "./paths.js";

export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_COMMAND_TIMEOUT = 60_000;
export const DEFAULT_NO_PROGRESS_LIMIT = 8;
export const DEFAULT_UNKNOWN_TOOL_LIMIT = 3;
export const DEFAULT_READONLY_CONCURRENCY = 4;
export const DEFAULT_FORK_WAIT_TIMEOUT_MS = 600_000;

export function createRuntimeConfig(
  workspace: string,
  model: ModelConfig,
  config: UserConfig,
  approveAll = config.agent?.approveAll === true,
  workMode: WorkMode = config.agent?.workMode ?? "auto",
  permissionMode: PermissionMode = workMode === "plan"
    ? "plan"
    : (config.agent?.permissionMode ?? (approveAll ? "bypass" : "auto")),
): RuntimeConfig {
  const stateRoot = projectStateRoot(workspace);
  const permissions: PermissionConfig = {
    workspace,
    workMode,
    mode: permissionMode,
    userRulesPath: compatibleUserDataPath("permissions.yaml"),
    projectRulesPath: resolve(stateRoot, "permissions.yaml"),
    localRulesPath: resolve(stateRoot, "permissions.local.yaml"),
    planDirectory: resolve(stateRoot, "plans"),
    allowedRoots: [resolve(workspace), resolve(tmpdir())],
  };
  const traceDb = resolve(stateRoot, "trace.db");
  return {
    workspace,
    model,
    workMode,
    permissionMode,
    loop: {
      maxRetries: DEFAULT_MAX_RETRIES,
      commandTimeout: DEFAULT_COMMAND_TIMEOUT,
      noProgressLimit: normalizeNoProgressLimit(config.agent?.noProgressLimit),
      unknownToolLimit: DEFAULT_UNKNOWN_TOOL_LIMIT,
      readonlyConcurrency: DEFAULT_READONLY_CONCURRENCY,
    },
    permissions,
    subagent: {
      forkWaitTimeoutMs: normalizeForkWaitTimeout(config.subagent?.forkWaitTimeoutMs),
      ...(config.subagent?.maxTokens === undefined
        ? {}
        : { maxTokens: normalizeSubagentMaxTokens(config.subagent.maxTokens) }),
    },
    approveAll,
    traceDb,
  };
}

function normalizeForkWaitTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FORK_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("subagent.forkWaitTimeoutMs must be a finite non-negative number");
  }
  return value;
}

function normalizeSubagentMaxTokens(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("subagent.maxTokens must be a positive integer");
  }
  return value;
}

function normalizeNoProgressLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_NO_PROGRESS_LIMIT;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("agent.noProgressLimit must be a finite non-negative number");
  }
  return Math.floor(value);
}
