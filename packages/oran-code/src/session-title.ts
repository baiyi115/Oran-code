import { loadConfig, resolveModelConfig } from "./config.js";
import { firstConversationPrompt, isAutomaticSessionName, truncateSessionName, type SessionStore, type StoredSession } from "./session-store.js";
import type { ModelConfig, ModelProvider, SessionTitleMode, UserConfig } from "./types.js";

export interface SessionTitleServiceDependencies {
  readonly workspace: string;
  readonly sessionStore: SessionStore;
  readonly providerFactory: (model: ModelConfig) => ModelProvider;
  readonly config: () => UserConfig;
  readonly titleMode: () => SessionTitleMode;
  /** 与会话持久化共用的串行写队列;任务异常被吞掉并返回 undefined。 */
  readonly runSerialSessionWrite: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  /** 会话记录被更新后回写内存中的 currentSession;persisted 为 true 时同时刷新 TUI。 */
  readonly onSessionUpdated: (session: StoredSession, options: { refreshTui: boolean }) => void;
}

/**
 * 会话标题的后台生成服务(model 模式)。从 TerminalSession 提取,
 * 行为保持不变:每会话只尝试一次、标题模型低温短输出、结果经串行链落盘。
 */
export class SessionTitleService {
  private readonly jobs = new Set<Promise<void>>();
  private readonly abortControllers = new Set<AbortController>();

  constructor(private readonly deps: SessionTitleServiceDependencies) {}

  schedule(sessionId: string, model: ModelConfig): void {
    if (this.deps.titleMode() !== "model") return;
    const abortController = new AbortController();
    this.abortControllers.add(abortController);
    const job = this.generate(sessionId, model, abortController.signal)
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(job);
        this.abortControllers.delete(abortController);
      });
    this.jobs.add(job);
  }

  abortAll(): void {
    for (const controller of this.abortControllers) controller.abort();
  }

  waitForIdle(): Promise<void> {
    return Promise.allSettled([...this.jobs]).then(() => undefined);
  }

  private async generate(sessionId: string, model: ModelConfig, signal: AbortSignal): Promise<void> {
    const stored = await this.deps.sessionStore.ensureConversation(sessionId) ?? this.deps.sessionStore.find(sessionId);
    const prompt = firstConversationPrompt(stored?.conversation ?? []);
    if (!prompt || !await this.markAttempted(sessionId)) return;

    const configuredTitleModel = this.deps.config().sessionTitles?.model;
    const configuredModel = configuredTitleModel
      ? resolveModelConfig(await loadConfig(this.deps.workspace), configuredTitleModel)
      : model;
    const titleModel: ModelConfig = {
      ...configuredModel,
      temperature: Math.min(configuredModel.temperature, 0.2),
      maxTokens: Math.min(configuredModel.maxTokens, 64),
    };
    const response = await this.deps.providerFactory(titleModel).complete([
      {
        role: "system",
        content: "Create a concise session title for a coding-agent conversation. Return only the title: 12-24 Chinese characters or at most 8 English words. Do not use quotes, markdown, trailing punctuation, or generic labels.",
      },
      { role: "user", content: prompt.slice(0, 2_000) },
    ], [], { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    const title = normalizeGeneratedSessionTitle(response.text);
    if (!title) return;
    await this.persist(sessionId, title);
  }

  private async markAttempted(sessionId: string): Promise<boolean> {
    const marked = await this.deps.runSerialSessionWrite(async () => {
      const session = this.deps.sessionStore.find(sessionId);
      if (!session || session.titleGenerationAttempted || !isAutomaticSessionName(session) || session.titleSource === "model") return undefined;
      const updated = await this.deps.sessionStore.update(sessionId, { titleGenerationAttempted: true });
      if (!updated) return undefined;
      this.deps.onSessionUpdated(updated, { refreshTui: false });
      return true;
    });
    return marked === true;
  }

  private async persist(sessionId: string, title: string): Promise<void> {
    const updated = await this.deps.runSerialSessionWrite(async () => {
      const session = this.deps.sessionStore.find(sessionId);
      if (!session || !isAutomaticSessionName(session) || session.titleSource === "manual") return undefined;
      return this.deps.sessionStore.update(sessionId, {
        name: title,
        autoNamed: true,
        titleSource: "model",
        titleGenerationAttempted: true,
      });
    });
    if (updated) this.deps.onSessionUpdated(updated, { refreshTui: true });
  }
}

export function normalizeGeneratedSessionTitle(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return undefined;
  const normalized = line
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^[#*`'"“”‘’\s]+|[#*`'"“”‘’\s]+$/g, "")
    .replace(/[。.!！?？:：;,，；]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? truncateSessionName(normalized, 48) : undefined;
}
