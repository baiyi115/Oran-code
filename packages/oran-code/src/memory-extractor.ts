import type { ModelProvider } from "./types.js";
import { MemoryManager, normalizeMemoryNoteType, type MemoryNote, type MemoryWriteInput } from "./memory-manager.js";

export interface MemoryExtractorOptions {
  readonly manager: MemoryManager;
  readonly provider: ModelProvider;
  readonly minSnapshotLength?: number;
  readonly onProcessed?: (snapshot: string, notes: readonly MemoryNote[], succeeded: boolean) => void;
}

export const NO_MEMORY_PLACEHOLDER = "NOTHING_TO_RECORD";

const DEFAULT_MIN_SNAPSHOT_LENGTH = 40;
const EXTRACTION_SYSTEM_PROMPT = [
  "Extract durable long-term memories from the supplied coding-agent conversation.",
  "Deduplicate against the existing memory summary. Do not record transient task progress or secrets.",
  "Allowed TYPE values: user-preference, correction-feedback, project-knowledge, reference-material.",
  "Return NOTHING_TO_RECORD when no durable information is worth saving.",
  "Otherwise return one or more blocks separated by a line containing only ---.",
  "Each block must use this exact format:",
  "ID: stable-kebab-case-id",
  "TYPE: one-allowed-type",
  "DESCRIPTION: one concise sentence",
  "FILENAME: optional-readable-name.md",
  "BODY:",
  "Detailed reusable memory in Markdown.",
].join("\n");

export class MemoryExtractor {
  private readonly manager: MemoryManager;
  private readonly provider: ModelProvider;
  private readonly minSnapshotLength: number;
  private readonly onProcessed: NonNullable<MemoryExtractorOptions["onProcessed"]>;
  private runningJob: Promise<void> | undefined;
  private pendingLatest: string | undefined;

  constructor(options: MemoryExtractorOptions) {
    this.manager = options.manager;
    this.provider = options.provider;
    this.minSnapshotLength = positiveInteger(options.minSnapshotLength, DEFAULT_MIN_SNAPSHOT_LENGTH);
    this.onProcessed = options.onProcessed ?? (() => undefined);
  }

  async extract(snapshot: string): Promise<MemoryNote[]> {
    const normalized = snapshot.trim();
    if (normalized.length < this.minSnapshotLength) return [];
    if (this.runningJob) {
      const superseded = this.pendingLatest;
      this.pendingLatest = normalized;
      if (superseded && superseded !== normalized) this.onProcessed(superseded, [], false);
      return [];
    }

    let firstResult: MemoryNote[] = [];
    const job = this.drain(normalized, (notes) => {
      firstResult = notes;
    })
      .catch(() => undefined)
      .finally(() => {
        if (this.runningJob === job) this.runningJob = undefined;
      });
    this.runningJob = job;
    await job;
    return firstResult;
  }

  async waitForIdle(): Promise<void> {
    while (this.runningJob) await this.runningJob;
  }

  isRunning(): boolean {
    return this.runningJob !== undefined;
  }

  private async drain(initial: string, onFirst: (notes: MemoryNote[]) => void): Promise<void> {
    let current: string | undefined = initial;
    let first = true;
    while (current) {
      const result = await this.extractOnce(current);
      this.onProcessed(current, result.notes, result.succeeded);
      if (first) {
        first = false;
        onFirst(result.notes);
      }
      current = this.pendingLatest;
      this.pendingLatest = undefined;
    }
  }

  private async extractOnce(snapshot: string): Promise<{ notes: MemoryNote[]; succeeded: boolean }> {
    try {
      const summary = await this.manager.buildSummary();
      const response = await this.provider.complete([
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: ["Existing memory summary:", summary || "(empty)", "Conversation snapshot:", snapshot].join("\n\n"),
        },
      ]);
      const extracted = parseExtractedMemories(response.text);
      if (!extracted.length) return { notes: [], succeeded: true };
      const saved: MemoryNote[] = [];
      for (const note of extracted) {
        try {
          const result = await this.manager.writeNote(note);
          if (result) saved.push(result);
        } catch {
          // One bad note must not prevent the remaining valid notes from being saved.
        }
      }
      return { notes: saved, succeeded: true };
    } catch {
      return { notes: [], succeeded: false };
    }
  }
}

export function parseExtractedMemories(value: string): MemoryWriteInput[] {
  const content = value.trim();
  if (!content || /^(?:NOTHING_TO_RECORD|无可记录)[.!。]?$/iu.test(content)) return [];
  const blocks = content.split(/^\s*---+\s*$/gmu);
  const notes: MemoryWriteInput[] = [];
  for (const block of blocks) {
    const id = field(block, "ID|标识");
    const type = normalizeMemoryNoteType(field(block, "TYPE|类型"));
    const description = field(block, "DESCRIPTION|描述") ?? "";
    const fileName = field(block, "FILENAME|文件名");
    const body = bodyField(block);
    if (!id || !type || !body) continue;
    notes.push({ id, type, description, body, ...(fileName ? { fileName } : {}) });
  }
  return notes;
}

function field(block: string, names: string): string | undefined {
  const match = new RegExp(`^(?:${names})\\s*:\\s*(.+?)\\s*$`, "imu").exec(block);
  return match?.[1]?.trim() || undefined;
}

function bodyField(block: string): string | undefined {
  const marker = /^(?:BODY|正文)\s*:\s*(.*)$/imu.exec(block);
  if (!marker || marker.index === undefined) return undefined;
  const firstLine = marker[1]?.trim() ?? "";
  const remainder = block.slice(marker.index + marker[0].length).trim();
  const body = [firstLine, remainder].filter(Boolean).join("\n").trim();
  return body || undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
