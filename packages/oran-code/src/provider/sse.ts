import { SseIdleTimeoutError } from "./errors.js";

export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 60_000;

export async function* readSseEvents(
  stream: AsyncIterable<Uint8Array>,
  idleTimeoutMs: number | undefined,
  onIdle: () => void,
): AsyncGenerator<string> {
  const timeoutMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs! > 0 ? idleTimeoutMs! : DEFAULT_SSE_IDLE_TIMEOUT_MS;
  const decoder = new TextDecoder();
  let buffer = "";
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextChunkWithIdleTimeout(iterator.next(), timeoutMs, onIdle);
      if (next.done) break;
      const chunk = next.value;
      if (!chunk) continue;
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (event.trim()) yield event;
      }
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Preserve the read or timeout error that caused the stream to close.
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

async function nextChunkWithIdleTimeout<T>(
  next: Promise<IteratorResult<T>>,
  idleTimeoutMs: number,
  onIdle: () => void,
): Promise<IteratorResult<T>> {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return next;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onIdle();
          reject(new SseIdleTimeoutError(idleTimeoutMs));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseSseJson(event: string): Record<string, unknown> | undefined {
  const dataLines: string[] = [];
  for (const line of event.split(/\r\n|\r|\n/)) {
    if (line === "data") {
      dataLines.push("");
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) return undefined;
  const data = dataLines.join("\n");
  if (!data.trim() || data.trim() === "[DONE]") return undefined;
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid SSE JSON payload: expected an object");
  }
  return parsed as Record<string, unknown>;
}
