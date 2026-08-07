import type { ToolCall } from "../types.js";
import { redactSecretText, redactSecrets } from "./interaction.js";
import { highlightSelection } from "./overlay/select-list.js";
import { visibleWidth, wrapDisplayText } from "./text-width.js";

export const APPROVAL_OPTIONS = ["Allow once", "Always allow", "Reject"] as const;

export function approvalDialogLines(
  call: ToolCall,
  level: number,
  description: string,
  workspace: string,
  selectedIndex: number,
  width = 80,
): string[] {
  const details = redactSecrets(call.arguments) as Record<string, unknown>;
  const lines = ["Permission required", "", `Tool: ${call.name}`];
  if (typeof details.command === "string") lines.push(`Command: ${redactSecretText(details.command)}`);
  if (typeof details.path === "string") lines.push(`Path: ${redactSecretText(details.path)}`);
  lines.push(`Directory: ${workspace}`, `Permission level: ${level}`);
  if (description.trim()) lines.push("", redactSecretText(description.trim()));
  for (const [key, value] of Object.entries(details)) {
    if (["command", "path"].includes(key)) continue;
    lines.push(`${key}: ${redactSecretText(formatValue(value))}`);
  }
  lines.push("", ...APPROVAL_OPTIONS.map((option, index) => highlightSelection(`  ${option}`, index === selectedIndex)), "", "↑↓ Select   Enter Confirm   Esc Reject");
  return lines.flatMap((line) => {
    if (!line) return [""];
    // Keep Blessed selection tags on lines that already fit. Long detail
    // lines still use the plain-text wrapper because they are not selectable.
    return visibleWidth(line) <= width ? [line] : wrapDisplayText(line, width);
  });
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
