export class SseIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model stream received no data for ${timeoutMs}ms`);
    this.name = "SseIdleTimeoutError";
  }
}

export class ModelRequestError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`model API returned ${status}: ${detail}`);
    this.name = "ModelRequestError";
    this.status = status;
  }
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
