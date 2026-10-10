/**
 * Session-level debug observability: debug log file writing + runtime stream event sequence tracking.
 * Extracted from TerminalSession (debugLogTail/debugStreamSequences/debugStreamTurns/
 * writeDebugLog/debugRuntimeStream), behavior unchanged.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectStateRoot } from "./paths.js";
import type { RuntimeEvent } from "./types.js";

export type DebugLogSink = (message: string) => void;

/** Debug log written serially to .oran/debug/agent.jsonl; a no-op unless ORAN_DEBUG is enabled. */
export function createDebugLogSink(workspace: string): DebugLogSink {
  let tail: Promise<void> = Promise.resolve();
  return (message: string): void => {
    const enabled = /^(1|true|yes)$/i.test(process.env.ORAN_DEBUG ?? "");
    if (!enabled) return;
    const path = resolve(projectStateRoot(workspace), "debug", "agent.jsonl");
    tail = tail
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), data: message })}\n`, "utf8");
      })
      .catch(() => undefined);
  };
}

export class StreamDebugTracker {
  private readonly sequences = new Map<string, number>();
  private readonly turns = new Map<string, { deltaEvents: number; deltaChars: number }>();

  constructor(private readonly writeLog: DebugLogSink) {}

  track(event: RuntimeEvent): void {
    const taskSequenceKey = event.taskId;
    const lastSequence = this.sequences.get(taskSequenceKey);
    const sequenceGap = lastSequence !== undefined && event.sequence !== lastSequence + 1;
    this.sequences.set(taskSequenceKey, event.sequence);
    const turnKey = `${event.taskId}:${event.turnId ?? "current"}`;
    if (event.type === "assistant_delta" || event.type === "assistant_end") {
      if (event.type === "assistant_delta") {
        const turn = this.turns.get(turnKey) ?? { deltaEvents: 0, deltaChars: 0 };
        turn.deltaEvents += 1;
        turn.deltaChars += event.text.length;
        this.turns.set(turnKey, turn);
      }
      const turn = this.turns.get(turnKey) ?? { deltaEvents: 0, deltaChars: 0 };
      this.writeLog(
        JSON.stringify({
          event: "runtime_stream",
          type: event.type,
          taskId: event.taskId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          sequence: event.sequence,
          lastSequence,
          sequenceGap,
          deltaEvents: turn.deltaEvents,
          deltaChars: turn.deltaChars,
          ...(event.type === "assistant_end"
            ? {
                finalChars: event.text.length,
                finalCodePoints: [...event.text].length,
              }
            : {}),
        }),
      );
      if (event.type === "assistant_end") this.turns.delete(turnKey);
    }
    if (
      event.type === "completed" ||
      event.type === "cancelled" ||
      (event.type === "state" && (event.state === "failed" || event.state === "cancelled"))
    ) {
      this.sequences.delete(event.taskId);
      for (const key of [...this.turns.keys()]) {
        if (key.startsWith(`${event.taskId}:`)) this.turns.delete(key);
      }
    }
  }
}
