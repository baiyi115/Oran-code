/**
 * 兼容两类中止信号:标准 DOMException 与常见 fetch 实现抛出的
 * `Error({ name: "AbortError" })`。判定取最宽语义,避免漏判取消。
 */
export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}
