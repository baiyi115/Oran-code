/**
 * Format errors for user-facing TUI/CLI output.
 *
 * Default output is a concise explanation of what went wrong (message + useful
 * metadata). Stack traces are opt-in for process-level debugging only.
 */
export function formatErrorDetail(error: unknown, options: { includeStack?: boolean } = {}): string {
  const includeStack = options.includeStack === true;
  if (error instanceof Error) {
    const lines: string[] = [];
    const headline = simplifyModelRequestMessage(error.message) ?? (error.message.trim() || error.name || "Error");
    lines.push(headline);

    const record = error as Error & Record<string, unknown>;
    const code = record.code;
    if (code !== undefined && code !== null && String(code).trim()) {
      lines.push(`code: ${String(code)}`);
    }
    const status = record.status ?? record.statusCode;
    if (status !== undefined && status !== null && String(status).trim()) {
      lines.push(`status: ${String(status)}`);
    }
    const errno = record.errno;
    if (errno !== undefined && errno !== null && String(errno).trim()) {
      lines.push(`errno: ${String(errno)}`);
    }
    const path = record.path;
    if (typeof path === "string" && path.trim()) {
      lines.push(`path: ${path}`);
    }
    const syscall = record.syscall;
    if (typeof syscall === "string" && syscall.trim()) {
      lines.push(`syscall: ${syscall}`);
    }

    if (error.cause !== undefined) {
      lines.push(`cause: ${formatErrorDetail(error.cause, { includeStack: false })}`);
    }

    if (includeStack && error.stack) {
      const stack = error.stack
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line, index) => index === 0 || line.trim().length > 0)
        .slice(0, 14);
      if (stack.length) {
        lines.push("stack:");
        for (const line of stack) lines.push(`  ${line}`);
      }
    }

    return lines.join("\n");
  }

  if (typeof error === "string") return error;
  if (error === undefined) return "undefined";
  if (error === null) return "null";

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/**
 * Providers commonly put a JSON error envelope after the HTTP status. Keep
 * the useful nested message, but do not print the whole envelope in the TUI.
 */
function simplifyModelRequestMessage(message: string): string | undefined {
  const match = /^model API returned (\d{3}):\s*([\s\S]+)$/.exec(message.trim());
  if (!match) return undefined;
  const status = match[1];
  const detail = match[2]?.trim() ?? "";
  try {
    const parsed = JSON.parse(detail) as unknown;
    const nested = findReadableErrorMessage(parsed);
    if (nested) return `model API returned ${status}: ${nested}`;
  } catch {
    // Some providers return plain text; the original message is already useful.
  }
  return undefined;
}

function findReadableErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error_description"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  if (record.error && typeof record.error === "object") return findReadableErrorMessage(record.error);
  return undefined;
}

/**
 * Short explanation for transcript and status text.
 */
export function formatErrorMessage(error: unknown): string {
  return formatErrorDetail(error, { includeStack: false });
}
