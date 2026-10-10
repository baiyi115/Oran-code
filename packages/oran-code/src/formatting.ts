/** Pure formatting helpers shared by the rendering layer: the plain terminal and the TUI both use
 * them, so their behaviour cannot drift apart. */

/**
 * Key names that introduce a secret value. One source for the three rules below:
 * they used to carry separate copies, and one of them had already lost
 * `authorization`.
 */
const SECRET_KEY =
  "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|credential|token|authorization)";

export function redactSecretText(value: string): string {
  return (
    value
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
      // Tokens that identify themselves, with no key name to match on: a transcript
      // row is persisted, so a bare paste of one of these used to be stored as is.
      .replace(/\b(?:gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
      .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted]")
      .replace(/\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g, "[redacted]")
      .replace(/\b(Authorization\s*:\s*Bearer)\s+\S+/gi, "$1 [redacted]")
      // JSON form ("token": "v"): the key is quoted and the value is closed by a quote,
      // which the `key:` rules below cannot reach.
      .replace(new RegExp(`("[^"]*${SECRET_KEY}[^"]*"\\s*:\\s*")[^"]*(")`, "gi"), "$1[redacted]$2")
      // Quoted value after a key — NAME="v", key: 'v'. The unquoted rule below
      // excludes quotes from its value, so `GITHUB_TOKEN="ghp_…"` and
      // `password: "…"` reached the transcript and the session file verbatim.
      .replace(new RegExp(`(${SECRET_KEY}\\s*[=:]\\s*)(["'])[^"'\\n]*\\2`, "gi"), "$1$2[redacted]$2")
      .replace(new RegExp(`(${SECRET_KEY}\\s*[=:]\\s*)[^\\s,&"']+`, "gi"), "$1[redacted]")
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
