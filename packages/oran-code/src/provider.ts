/**
 * 薄 barrel：模型协议适配按协议拆分在 ./provider/ 目录下
 * （openai.ts / anthropic.ts + errors/sse/transport/catalog 共享层）。
 * 保留同名文件以维持既有 import 路径（含 session.ts 的动态 import("./provider.js")）不变。
 */
export {
  AnthropicProvider,
  OpenAICompatibleProvider,
  createModelProvider,
  fetchRemoteModels,
  resolveProviderProtocol,
  ModelRequestError,
  SseIdleTimeoutError,
} from "./provider/index.js";
export type { RemoteModel, RemoteProviderProtocol } from "./provider/index.js";
