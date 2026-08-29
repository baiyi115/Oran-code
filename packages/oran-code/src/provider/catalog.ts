import type { ModelConfig } from "../types.js";
import { CLIENT_ID, CLIENT_USER_AGENT, PRODUCT_VERSION } from "../paths.js";
import { stringOption } from "./transport.js";

export type RemoteProviderProtocol = "openai" | "anthropic";

export interface RemoteModel {
  id: string;
  /** Context window in tokens when the remote catalog reports one. */
  contextWindow?: number;
}

/**
 * Fetch the model catalog from a provider's /models endpoint. Normalizes the
 * base URL (strips a trailing slash, keeps an existing /v1) and adapts the
 * request shape to the OpenAI-compatible vs Anthropic conventions.
 */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string | undefined,
  protocol: RemoteProviderProtocol,
): Promise<RemoteModel[]> {
  const base = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": CLIENT_USER_AGENT,
    "x-oran-client": CLIENT_ID,
    "x-oran-version": PRODUCT_VERSION,
  };
  if (apiKey) {
    if (protocol === "anthropic") headers["x-api-key"] = apiKey;
    else headers.authorization = `Bearer ${apiKey}`;
  }
  const endpoint = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`model catalog request failed (${response.status} ${response.statusText})`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const data = Array.isArray(payload.data) ? payload.data : [];
  const models: RemoteModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || !id) continue;
    const contextWindow =
      numberField((entry as Record<string, unknown>).max_input_tokens) ??
      numberField((entry as Record<string, unknown>).context_window) ??
      numberField((entry as Record<string, unknown>).context_length);
    models.push({ id, ...(contextWindow !== undefined ? { contextWindow } : {}) });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveProviderProtocol(config: ModelConfig): "openai" | "anthropic" {
  const explicit =
    stringOption(config.options, "protocol") ??
    stringOption(config.options, "api") ??
    stringOption(config.options, "providerType");
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (normalized.includes("anthropic") || normalized === "claude") return "anthropic";
    if (normalized.includes("openai") || normalized.includes("compatible")) return "openai";
  }
  const providerName = config.provider.toLowerCase();
  if (providerName.includes("anthropic") || providerName.includes("claude")) return "anthropic";
  const base = (config.baseUrl ?? "").toLowerCase();
  if (base.includes("anthropic") || base.includes("claude")) return "anthropic";
  return "openai";
}
