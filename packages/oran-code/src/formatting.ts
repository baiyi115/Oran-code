/** Pure formatting helpers shared by the rendering layer: the plain terminal and the TUI both use
 * them, so their behaviour cannot drift apart. */

export function redactSecretText(value: string): string {
  return (
    value
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
      .replace(/\b(Authorization\s*:\s*Bearer)\s+\S+/gi, "$1 [redacted]")
      // JSON form ("token": "v"): the key is quoted and the value is closed by a quote,
      // which the `key:` rule above cannot reach.
      .replace(
        /("[^"]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|credential|token|authorization)[^"]*"\s*:\s*")[^"]*(")/gi,
        "$1[redacted]$2",
      )
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|credential|token)\s*[=:]\s*)[^\s,&"]+/gi,
        "$1[redacted]",
      )
  );
}

export function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(value))}ms`;
}

/** Truncates by UTF-16 length and marks the cut; used on the plain terminal path. */
export function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

export function formatRate(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}
