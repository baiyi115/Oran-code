/**
 * Thin barrel: model protocol adapters are split by protocol under ./provider/
 * (openai.ts / anthropic.ts plus the shared errors/sse/transport/catalog layer).
 * Keeping a file of the same name preserves existing import paths, including
 * session.ts's dynamic import("./provider.js").
 */
export {
  AnthropicProvider,
  OpenAICompatibleProvider,
  createModelProvider,
  fetchRemoteModels,
  resolveProviderProtocol,
  resolveProviderProtocolFor,
  ModelRequestError,
  SseIdleTimeoutError,
} from "./provider/index.js";
export type { RemoteModel, RemoteProviderProtocol } from "./provider/index.js";
