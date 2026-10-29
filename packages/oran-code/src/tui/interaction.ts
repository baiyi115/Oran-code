import type { ApprovalResponse } from "../types.js";
import { redactSecretText } from "../formatting.js";

export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** Move a list cursor by `delta` and stop at either end (lists that do not wrap). */
export function stepSelection(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index + delta));
}

export function approvalResponse(index: number): ApprovalResponse {
  if (index === 0) return "task";
  if (index === 1) return true;
  if (index === 2) return "always";
  return false;
}

export interface HistoryNavigation {
  value: string;
  index: number | undefined;
  draft: string;
}

export function navigateHistory(
  history: readonly string[],
  index: number | undefined,
  direction: "older" | "newer",
  currentValue: string,
  draft: string,
): HistoryNavigation {
  if (!history.length) return { value: currentValue, index: undefined, draft };
  if (direction === "older") {
    const nextIndex = index === undefined ? 0 : Math.min(index + 1, history.length - 1);
    return {
      value: history[nextIndex] ?? currentValue,
      index: nextIndex,
      draft: index === undefined ? currentValue : draft,
    };
  }
  if (index === undefined) return { value: currentValue, index, draft };
  if (index === 0) return { value: draft, index: undefined, draft };
  const nextIndex = index - 1;
  return { value: history[nextIndex] ?? currentValue, index: nextIndex, draft };
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSecretText(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/api[_-]?key|token|secret|password|authorization/i.test(key)) return [key, "[redacted]"];
      return [key, redactSecrets(item)];
    }),
  );
}
