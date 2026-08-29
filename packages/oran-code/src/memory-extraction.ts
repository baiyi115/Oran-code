import type { MemoryManager } from "./memory-manager.js";
import type { MemoryExtractor } from "./memory-extractor.js";
import type { Message, ModelConfig, ModelProvider } from "./types.js";

export interface MemoryExtractionDependencies {
  readonly memoryManager: MemoryManager;
  readonly providerFactory: (model: ModelConfig) => ModelProvider;
  /** 当前会话 id;笔记落盘后仅在对应会话激活时提示。 */
  readonly currentSessionId: () => string | undefined;
  readonly onNotesSaved: (sessionId: string, noteIds: readonly string[]) => void;
}

/**
 * 后台记忆提取调度器:对话快照增量 ≥40 字符才触发,提取器单飞 +
 * 最新覆盖合并,任务集合在 shutdown 时被等待。从 TerminalSession 提取,
 * 行为保持不变。
 */
export class MemoryExtractionScheduler {
  private extractor: MemoryExtractor | undefined;
  private extractorInit: Promise<MemoryExtractor> | undefined;
  private readonly jobs = new Set<Promise<void>>();
  private extractorModelKey: string | undefined;
  private readonly snapshots = new Map<string, string>();
  private readonly pendingSnapshots = new Map<string, string>();

  constructor(private readonly deps: MemoryExtractionDependencies) {}

  schedule(sessionId: string, messages: readonly Message[], model: ModelConfig): void {
    const snapshot = serializeMemorySnapshot(messages);
    const previous = this.snapshots.get(sessionId);
    if (!snapshot || memorySnapshotDelta(previous, snapshot) < 40) return;
    this.pendingSnapshots.set(snapshot, sessionId);
    const modelKey = `${model.provider}/${model.model}/${model.baseUrl ?? ""}`;
    const job = (async () => {
      const extractor = await this.ensureExtractor(model, modelKey);
      await extractor.extract(snapshot).catch(() => undefined);
    })();
    this.jobs.add(job);
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    );
  }

  /** shutdown 先等待初始化 promise,防止迟到的 SQLite/模型句柄泄漏。 */
  init(): Promise<MemoryExtractor> | undefined {
    return this.extractorInit;
  }

  hasPendingJobs(): boolean {
    return this.jobs.size > 0;
  }

  waitForJobs(): Promise<void> {
    return Promise.allSettled([...this.jobs]).then(() => undefined);
  }

  async waitForExtractorIdle(): Promise<void> {
    await this.extractor?.waitForIdle();
  }

  private ensureExtractor(model: ModelConfig, modelKey: string): Promise<MemoryExtractor> {
    const current = this.extractor;
    if (current && (current.isRunning() || this.extractorModelKey === modelKey)) return Promise.resolve(current);
    if (this.extractorInit) return this.extractorInit;

    const initialization = (async () => {
      const existing = this.extractor;
      if (existing && (existing.isRunning() || this.extractorModelKey === modelKey)) return existing;
      const { MemoryExtractor: LoadedExtractor } = await import("./memory-extractor.js");
      const extractor = new LoadedExtractor({
        manager: this.deps.memoryManager,
        provider: this.deps.providerFactory(model),
        onProcessed: (processedSnapshot, notes, succeeded) => {
          const processedSessionId = this.pendingSnapshots.get(processedSnapshot);
          this.pendingSnapshots.delete(processedSnapshot);
          if (!processedSessionId) return;
          if (succeeded) this.snapshots.set(processedSessionId, processedSnapshot);
          if (notes.length)
            this.deps.onNotesSaved(
              processedSessionId,
              notes.map((note) => note.id),
            );
        },
      });
      this.extractor = extractor;
      this.extractorModelKey = modelKey;
      return extractor;
    })();
    this.extractorInit = initialization;
    void initialization.then(
      () => {
        if (this.extractorInit === initialization) this.extractorInit = undefined;
      },
      () => {
        if (this.extractorInit === initialization) this.extractorInit = undefined;
      },
    );
    return initialization;
  }
}

export function serializeMemorySnapshot(messages: readonly Message[]): string {
  const candidates = messages
    .filter((message) => message.role !== "system")
    .slice(-48)
    .map((message) => {
      const content = message.content?.trim().slice(0, 4_000) ?? "";
      const calls = message.toolCalls?.length
        ? `\nTool calls: ${message.toolCalls.map((call) => call.name).join(", ")}`
        : "";
      if (content.length < 8 && !calls) return "";
      return `${message.role.toUpperCase()}${message.name ? ` (${message.name})` : ""}:\n${content}${calls}`.trim();
    })
    .filter(Boolean);
  const retained: string[] = [];
  let bytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const candidateBytes = Buffer.byteLength(`${candidate}\n\n`, "utf8");
    if (bytes + candidateBytes > 32_000) break;
    retained.unshift(candidate);
    bytes += candidateBytes;
  }
  return retained.join("\n\n");
}

export function memorySnapshotDelta(previous: string | undefined, current: string): number {
  if (!previous) return current.length;
  let common = 0;
  const maximum = Math.min(previous.length, current.length);
  while (common < maximum && previous.charCodeAt(common) === current.charCodeAt(common)) common += 1;
  return current.length - common;
}
