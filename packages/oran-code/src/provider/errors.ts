export class SseIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model stream received no data for ${timeoutMs}ms`);
    this.name = "SseIdleTimeoutError";
  }
}

export class ModelRequestError extends Error {
  readonly status: number;
  /** 服务端要求的退避时长(毫秒),来自 Retry-After 响应头;无则 undefined。 */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, detail: string, retryAfterMs?: number) {
    super(`model API returned ${status}: ${detail}`);
    this.name = "ModelRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 解析 Retry-After(秒数或 HTTP 日期),无法识别时返回 undefined。 */
export function retryAfterMsFromResponse(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.ceil(seconds * 1000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
  return undefined;
}

export async function boundedError(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}

export function streamErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
