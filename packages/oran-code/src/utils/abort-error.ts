/**
 * Handles both kinds of abort signal: the standard DOMException and the
 * `Error({ name: "AbortError" })` that common fetch implementations throw. The check takes the
 * broadest reading so a cancellation is never missed.
 */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
