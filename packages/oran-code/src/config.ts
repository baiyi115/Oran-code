import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { legacyUserDataRoot, PROJECT_STATE_DIRECTORY, userDataRoot } from "./paths.js";
import { isPermissionMode, isReasoningEffort } from "./types.js";
import type {
  AgentSettings,
  ModelConfig,
  ModelOptions,
  ModelProfile,
  McpServerConfig,
  ProviderOptions,
  ProviderProfile,
  ReasoningEffort,
  SessionTitleSettings,
  UserConfig,
} from "./types.js";

const defaultConfig: UserConfig = { providers: {} };

export function userConfigPath(): string {
  return resolve(userDataRoot(), "config.json");
}

/**
 * The pre-0.1 location is kept as a read-only fallback so existing installs
 * continue to work after the user-directory layout changes.
 */
export function legacyUserConfigPath(): string {
  return resolve(legacyUserDataRoot(), "config.json");
}

function oldestUserConfigPath(): string {
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "liteagent", "config.json");
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "liteagent", "config.json");
}

export function userConfigReadPath(): string {
  const primary = userConfigPath();
  if (existsSync(primary)) return primary;
  return [legacyUserConfigPath(), oldestUserConfigPath()].find(existsSync) ?? primary;
}

export function userHistoryPath(): string {
  return resolve(userDataRoot(), "history");
}

export function legacyUserHistoryPath(): string {
  return resolve(legacyUserDataRoot(), "history");
}

/** Ensure the user directory exists and migrate the pre-0.1 config once. */
export async function ensureUserConfig(): Promise<string> {
  const primary = userConfigPath();
  await mkdir(dirname(primary), { recursive: true });
  const legacy = [legacyUserConfigPath(), oldestUserConfigPath()].find(existsSync);
  if (!existsSync(primary) && legacy) await copyFile(legacy, primary);
  return primary;
}

export function projectConfigPath(workspace: string): string {
  return resolve(workspace, PROJECT_STATE_DIRECTORY, "config.json");
}

export function legacyProjectConfigPath(workspace: string): string {
  return resolve(workspace, ".liteagent", "config.json");
}

async function readConfig(path: string): Promise<UserConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level JSON value must be an object");
    }
    const value = normalizeConfig(parsed);
    return {
      ...defaultConfig,
      ...value,
      providers: normalizeProviders(value.providers),
      ...(value.agent ? { agent: value.agent } : {}),
      ...(value.sessionTitles ? { sessionTitles: value.sessionTitles } : {}),
      ...(value.mcpServers ? { mcpServers: value.mcpServers } : {}),
    };
  } catch (error) {
    if (isMissingFile(error)) return { ...defaultConfig };
    throw new Error(`cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeConfig(value: unknown): UserConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("top-level JSON value must be an object");
  }
  const item = value as Record<string, unknown>;
  const result: UserConfig = { providers: normalizeProviders(item.providers) };
  const agent = normalizeAgentSettings(item.agent);
  if (agent) result.agent = agent;
  const sessionTitles = normalizeSessionTitleSettings(item.sessionTitles);
  if (sessionTitles) result.sessionTitles = sessionTitles;
  const mcpServers = normalizeMcpServers(item.mcpServers);
  if (mcpServers) result.mcpServers = mcpServers;

  // Read the pre-0.1 top-level settings so an existing installation remains usable.
  // Legacy top-level model/default fields stay ignored; the current preference lives at agent.lastModel.
  const legacyAgent: AgentSettings = {};
  const approveAll = booleanOrUndefined(item.approve_all ?? item.approveAll);
  const skipVerify = booleanOrUndefined(item.skip_verify ?? item.skipVerify);
  const maxSteps = numberOrUndefined(item.max_steps ?? item.maxSteps);
  const tokenBudget = numberOrUndefined(item.token_budget ?? item.tokenBudget);
  const permissionModeValue = item.permission_mode ?? item.permissionMode;
  const permissionMode = isPermissionMode(permissionModeValue) ? permissionModeValue : undefined;
  if (approveAll !== undefined) legacyAgent.approveAll = approveAll;
  if (skipVerify !== undefined) legacyAgent.skipVerify = skipVerify;
  if (maxSteps !== undefined) legacyAgent.maxSteps = maxSteps;
  if (tokenBudget !== undefined) legacyAgent.tokenBudget = tokenBudget;
  if (permissionMode !== undefined) legacyAgent.permissionMode = permissionMode;
  if (Object.keys(legacyAgent).length) result.agent = { ...legacyAgent, ...result.agent };

  // Very old configs allowed endpoint credentials at the top level. When there is
  // exactly one provider, fold them into that provider without creating an implicit model.
  const rootOptions = normalizeOptions(item);
  const providerNames = Object.keys(result.providers);
  if (Object.keys(rootOptions).length && providerNames.length === 1) {
    const providerName = providerNames[0];
    if (providerName) {
      const provider = result.providers[providerName];
      if (provider) provider.options = { ...rootOptions, ...provider.options };
    }
  }
  return result;
}

function normalizeSessionTitleSettings(value: unknown): SessionTitleSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sessionTitles must be an object");
  }
  const mode = (value as Record<string, unknown>).mode;
  const model = stringOrUndefined((value as Record<string, unknown>).model);
  if (mode !== undefined && mode !== "first-message" && mode !== "local" && mode !== "model") {
    throw new Error("invalid sessionTitles.mode; use first-message, local, or model");
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function normalizeMcpServers(value: unknown): Record<string, McpServerConfig> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mcpServers must be an object");
  }
  const result: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`mcpServers.${name} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const command = optionalString(item.command, `mcpServers.${name}.command`);
    const url = optionalString(item.url, `mcpServers.${name}.url`);
    const args = optionalStringArray(item.args, `mcpServers.${name}.args`);
    const env = optionalStringMap(item.env, `mcpServers.${name}.env`);
    const headers = optionalStringMap(item.headers, `mcpServers.${name}.headers`);
    if (item.transport !== undefined && item.transport !== "sse") {
      throw new Error(`mcpServers.${name}.transport must be sse`);
    }
    result[name] = {
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(item.transport === "sse" ? { transport: "sse" } : {}),
    };
  }
  return result;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...value] as string[];
}

function optionalStringMap(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object of string values`);
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") throw new Error(`${path}.${key} must be a string`);
    result[key] = raw;
  }
  return result;
}

function normalizeAgentSettings(value: unknown): AgentSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const result: AgentSettings = {};
  const approveAll = booleanOrUndefined(item.approveAll ?? item.approve_all);
  const skipVerify = booleanOrUndefined(item.skipVerify ?? item.skip_verify);
  const maxSteps = numberOrUndefined(item.maxSteps ?? item.max_steps);
  const tokenBudget = numberOrUndefined(item.tokenBudget ?? item.token_budget);
  const workMode = item.workMode === "plan" || item.workMode === "auto" ? item.workMode : undefined;
  const permissionModeValue = item.permissionMode ?? item.permission_mode;
  const permissionMode = isPermissionMode(permissionModeValue) ? permissionModeValue : undefined;
  const lastModel = stringOrUndefined(item.lastModel ?? item.last_model);
  if (approveAll !== undefined) result.approveAll = approveAll;
  if (skipVerify !== undefined) result.skipVerify = skipVerify;
  if (maxSteps !== undefined) result.maxSteps = maxSteps;
  if (tokenBudget !== undefined) result.tokenBudget = tokenBudget;
  if (workMode !== undefined) result.workMode = workMode;
  if (permissionMode !== undefined) result.permissionMode = permissionMode;
  if (lastModel !== undefined) result.lastModel = lastModel;
  return Object.keys(result).length ? result : undefined;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeProviders(value: unknown): Record<string, ProviderProfile> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const providers: Record<string, ProviderProfile> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const models: Record<string, ModelProfile> = {};
    if (item.models && typeof item.models === "object" && !Array.isArray(item.models)) {
      for (const [modelName, profile] of Object.entries(item.models)) {
        models[modelName] = normalizeModelProfile(modelName, profile);
      }
    }
    const options = {
      ...normalizeOptions(item.options),
      ...normalizeOptions(item),
    };
    validateContextWindow(options.contextWindow, `provider ${name}`);
    const npm = stringOrUndefined(item.npm);
    const displayName = stringOrUndefined(item.name);
    const profile: ProviderProfile = {
      ...(npm !== undefined ? { npm } : {}),
      ...(displayName !== undefined ? { name: displayName } : {}),
      options,
      models,
    };
    providers[name] = profile;
  }
  return providers;
}

function normalizeModelProfile(modelName: string, value: unknown): ModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name: modelName, options: {} };
  }
  const item = value as Record<string, unknown>;
  const options = {
    ...normalizeOptions(item.options),
    ...normalizeOptions(item),
  };
  validateReasoningEffort(options.reasoningEffort, modelName);
  validateContextWindow(options.contextWindow, `model ${modelName}`);
  const displayName = stringOrUndefined(item.name) ?? modelName;
  return { name: displayName, options };
}

function validateReasoningEffort(value: unknown, modelName: string): void {
  if (value !== undefined && !isReasoningEffort(value)) {
    throw new Error(`invalid reasoningEffort for model ${modelName}; use low, medium, high, or xhigh`);
  }
}

function normalizeOptions(value: unknown): ProviderOptions & ModelOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const item = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(item)) {
    if (["providers", "agent", "sessionTitles", "mcpServers", "workspace", "default", "model", "models", "options", "name", "npm", "default_model", "defaultModel"].includes(key)) continue;
    if (raw === undefined || raw === null) continue;
    const normalizedKey = key === "base_url" || key === "baseURL" ? "baseUrl"
      : key === "api_key" ? "apiKey"
        : key === "max_tokens" ? "maxTokens"
          : key === "context_window" ? "contextWindow"
          : key;
    result[normalizedKey] = raw;
  }
  return result as ProviderOptions & ModelOptions;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validateContextWindow(value: unknown, scope: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
    throw new Error(`invalid context_window for ${scope}; expected a positive integer`);
  }
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function merge(base: UserConfig, override: UserConfig): UserConfig {
  const providers: Record<string, ProviderProfile> = {};
  for (const [name, profile] of Object.entries(base.providers)) {
    providers[name] = { ...profile, options: { ...profile.options }, models: { ...profile.models } };
  }
  for (const [name, profile] of Object.entries(override.providers)) {
    providers[name] = {
      ...providers[name],
      ...profile,
      options: { ...providers[name]?.options, ...profile.options },
      models: { ...providers[name]?.models, ...profile.models },
    };
  }
  return {
    providers,
    ...(base.agent || override.agent ? { agent: { ...base.agent, ...override.agent } } : {}),
    ...(base.sessionTitles || override.sessionTitles
      ? { sessionTitles: { ...base.sessionTitles, ...override.sessionTitles } }
      : {}),
    ...(base.mcpServers || override.mcpServers
      ? { mcpServers: { ...base.mcpServers, ...override.mcpServers } }
      : {}),
  };
}

export async function loadConfig(workspace?: string): Promise<UserConfig> {
  await ensureUserConfig();
  let config = await readConfig(userConfigPath());
  if (workspace) {
    config = merge(config, await readConfig(legacyProjectConfigPath(workspace)));
    config = merge(config, await readConfig(projectConfigPath(workspace)));
  }
  return config;
}

/** Load one config file without merging it with the user or project config. */
export async function loadConfigFile(path: string): Promise<UserConfig> {
  return readConfig(path);
}

export async function saveConfig(config: UserConfig, path = userConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(toFileShape(config), null, 2) + "\n";
  await writeFile(path, payload, "utf8");
}

function toFileShape(config: UserConfig): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(config.providers)) {
    const providerOptions = serializeOptions(profile.options);
    const models: Record<string, unknown> = {};
    for (const [model, item] of Object.entries(profile.models)) {
      const modelOptions = serializeOptions(item.options);
      if (modelOptions.baseURL === providerOptions.baseURL) delete modelOptions.baseURL;
      if (modelOptions.apiKey === providerOptions.apiKey) delete modelOptions.apiKey;
      models[model] = {
        ...(item.name ? { name: item.name } : {}),
        options: modelOptions,
      };
    }
    providers[name] = {
      ...(profile.npm ? { npm: profile.npm } : {}),
      ...(profile.name ? { name: profile.name } : {}),
      options: providerOptions,
      models,
    };
  }
  return {
    providers,
    ...(config.agent ? { agent: config.agent } : {}),
    ...(config.sessionTitles ? { sessionTitles: config.sessionTitles } : {}),
    ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
  };
}

function serializeOptions(options: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const outputKey = key === "baseUrl" ? "baseURL"
      : key === "contextWindow" ? "context_window"
        : key;
    result[outputKey] = value;
  }
  return result;
}

export function resolveModelConfig(config: UserConfig, requested: string | undefined): ModelConfig {
  const reference = requested?.trim();
  if (!reference) throw new Error("no model selected; use /model PROVIDER/MODEL or pass --model PROVIDER/MODEL");

  let providerName: string;
  let modelName: string;
  if (reference.includes("/")) {
    const [provider, ...rest] = reference.split("/");
    if (!provider || rest.length === 0 || !rest.join("/").trim()) throw new Error("model must use provider/model format");
    providerName = provider;
    modelName = rest.join("/");
  } else {
    const matches = Object.entries(config.providers).filter(([, profile]) => reference in profile.models);
    if (matches.length > 1) throw new Error(`model reference is ambiguous: ${reference}; use provider/${reference}`);
    const match = matches[0];
    if (!match) throw new Error(`model is not configured: ${reference}; use /model to list models`);
    providerName = match[0];
    modelName = reference;
  }

  const provider = config.providers[providerName];
  if (!provider) throw new Error(`model provider is not configured: ${providerName}`);
  const profile = provider.models[modelName];
  if (!profile) throw new Error(`model is not configured: ${providerName}/${modelName}`);
  const providerOptions = provider.options;
  const modelOptions = profile.options;
  const baseUrl = process.env.ORAN_BASE_URL
    ?? process.env.LITEAGENT_BASE_URL
    ?? stringOrUndefined(modelOptions.baseUrl)
    ?? stringOrUndefined(providerOptions.baseUrl);
  const apiKey = process.env.ORAN_API_KEY
    ?? process.env.LITEAGENT_API_KEY
    ?? stringOrUndefined(modelOptions.apiKey)
    ?? stringOrUndefined(providerOptions.apiKey);
  const temperature = numberOrUndefined(modelOptions.temperature) ?? 0.2;
  const maxTokens = numberOrUndefined(modelOptions.maxTokens) ?? 4096;
  const contextWindow = numberOrUndefined(modelOptions.contextWindow)
    ?? numberOrUndefined(providerOptions.contextWindow)
    ?? defaultContextWindow(providerName, baseUrl, { ...providerOptions, ...modelOptions });
  const rawReasoningEffort = modelOptions.reasoningEffort;
  if (rawReasoningEffort !== undefined && !isReasoningEffort(rawReasoningEffort)) {
    throw new Error(`invalid reasoningEffort for model ${providerName}/${modelName}; use low, medium, high, or xhigh`);
  }
  const reasoningEffort: ReasoningEffort = rawReasoningEffort ?? "medium";
  const options = { ...providerOptions, ...modelOptions };
  delete options.baseUrl;
  delete options.apiKey;
  delete options.temperature;
  delete options.maxTokens;
  delete options.contextWindow;
  delete options.reasoningEffort;
  delete options.permission;
  const headers = normalizeHeaders(options.headers);
  delete options.headers;
  return {
    provider: providerName,
    model: modelName,
    temperature,
    maxTokens,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    reasoningEffort,
    ...(Object.keys(options).length ? { options } : {}),
  };
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("headers must be an object of string values");
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      throw new Error(`header ${key} must be a string`);
    }
    result[key] = raw;
  }
  return result;
}

function defaultContextWindow(
  providerName: string,
  baseUrl: string | undefined,
  options: Record<string, unknown>,
): number {
  const hints = [providerName, baseUrl, options.protocol, options.api, options.providerType]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return hints.includes("anthropic") || hints.includes("claude") ? 200_000 : 128_000;
}
