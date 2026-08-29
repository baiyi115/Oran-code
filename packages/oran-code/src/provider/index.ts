import type { ModelConfig, ModelProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai.js";
import { resolveProviderProtocol } from "./catalog.js";

export { AnthropicProvider } from "./anthropic.js";
export { OpenAICompatibleProvider } from "./openai.js";
export {
  fetchRemoteModels,
  resolveProviderProtocol,
} from "./catalog.js";
export type { RemoteModel, RemoteProviderProtocol } from "./catalog.js";
export { ModelRequestError, SseIdleTimeoutError } from "./errors.js";

/** Create a protocol adapter from model config without leaking protocol details upward. */
export function createModelProvider(config: ModelConfig): ModelProvider {
  const protocol = resolveProviderProtocol(config);
  if (protocol === "anthropic") return new AnthropicProvider(config);
  return new OpenAICompatibleProvider(config);
}
