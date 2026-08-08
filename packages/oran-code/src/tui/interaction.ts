import { DEFAULT_COMMAND_REGISTRY, type SlashCommand } from "../commands.js";
import type { ApprovalResponse } from "../types.js";
import { commandCandidates } from "./command-palette.js";

export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function filterCommands(query: string, commands: readonly SlashCommand[] = DEFAULT_COMMAND_REGISTRY.list()): SlashCommand[] {
  return commandCandidates(query.trim() || "/", commands);
}

export function approvalResponse(index: number): ApprovalResponse {
  if (index === 0) return true;
  if (index === 1) return "always";
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
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/api[_-]?key|token|secret|password|authorization/i.test(key)) return [key, "[redacted]"];
    return [key, redactSecrets(item)];
  }));
}

export function redactSecretText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,&]+/gi, "$1[redacted]");
}
