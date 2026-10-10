export class SseIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model stream received no data for ${timeoutMs}ms`);
    this.name = "SseIdleTimeoutError";
  }
}

export class ModelRequestError extends Error {
  readonly status: number;
  /** Backoff duration in milliseconds requested by the server, from the Retry-After header; undefined if absent. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, detail: string, retryAfterMs?: number) {
    super(`model API returned ${status}: ${detail}`);
    this.name = "ModelRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse Retry-After (a number of seconds or an HTTP date); returns undefined when unrecognized. */
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

export function streamErrorToModelRequestError(value: unknown, fallback: string): Error {
  const detail = streamErrorMessage(value, fallback);
  let status: number | undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.status === "number" && Number.isInteger(obj.status)) status = obj.status;
    else if (typeof obj.statusCode === "number" && Number.isInteger(obj.statusCode)) status = obj.statusCode;
    else if (typeof obj.code === "number" && Number.isInteger(obj.code)) status = obj.code;
    else if (typeof obj.code === "string" && /^\d{3}$/.test(obj.code.trim())) status = Number(obj.code.trim());
    else if (obj.type === "invalid_request_error") status = 400;
    else if (obj.type === "authentication_error") status = 401;
    else if (obj.type === "permission_error") status = 403;
    else if (obj.type === "not_found_error") status = 404;
    else if (obj.type === "rate_limit_error") status = 429;
  }
  if (status === undefined) {
    if (
      /please ensure that|invalid[_\s-]?parameter|invalid[_\s-]?request|validation[_\s-]?error|bad request/i.test(
        detail,
      )
    ) {
      status = 400;
    }
  }
  if (status !== undefined) {
    return new ModelRequestError(status, detail);
  }
  return new Error(detail);
}
