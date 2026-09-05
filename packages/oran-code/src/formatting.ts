/** 渲染层共享的纯格式化工具:普通终端与 TUI 两条路径共用,避免行为漂移。 */

export function redactSecretText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(Authorization\s*:\s*Bearer)\s+\S+/gi, "$1 [redacted]")
    // JSON 形态("token": "v"):键带引号,值以引号闭合,`key:` 规则覆盖不到。
    .replace(
      /("[^"]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|credential|token|authorization)[^"]*"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|credential|token)\s*[=:]\s*)[^\s,&"]+/gi,
      "$1[redacted]",
    );
}

export function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(value))}ms`;
}

/** 按 UTF-16 长度截断并标注;普通终端路径使用。 */
export function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

export function formatRate(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}
