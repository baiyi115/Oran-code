import type { ToolCall } from "../types.js";
import { redactSecretText, redactSecrets } from "./interaction.js";
import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { wrapDisplayText } from "./text-width.js";
import { subagentOriginLabel, type SubagentOrigin } from "../subagent/types.js";

const APPROVAL_OPTIONS = ["Allow for this task", "Allow once", "Always allow", "Reject"] as const;

/**
 * "Allow once" is the default: the dialog pops up while the user is still typing, so Enter must not
 * hand over a standing permission nobody asked for — and `y` (the quick answer) resolves to the
 * same option, so the default and the hint agree.
 */
export const APPROVAL_DEFAULT_INDEX = 1;

const APPROVAL_HINT = "↑↓ Select   Enter Confirm   y Allow once   n/Esc Reject";
/** Argument values longer than this are summarized: the dialog is for orientation, not for review. */
const VALUE_MAX_CHARS = 200;
const VALUE_MAX_LINES = 4;

export function approvalDialogLines(
  call: ToolCall,
  level: number,
  description: string,
  workspace: string,
  origin: SubagentOrigin,
  selectedIndex: number,
  width = 80,
  capacity?: number,
): OverlayLine[] {
  const details = redactSecrets(call.arguments) as Record<string, unknown>;
  // What the call touches comes before where it came from: that is what the user has to judge.
  const head = ["Permission required", "", `Tool: ${call.name}`];
  if (typeof details.command === "string") head.push(`Command: ${redactSecretText(details.command)}`);
  if (typeof details.path === "string") head.push(`Path: ${redactSecretText(details.path)}`);
  head.push(`Source: ${subagentOriginLabel(origin)}`, `Directory: ${workspace}`, `Permission level: ${level}`);

  const body: string[] = [];
  if (description.trim()) body.push("", redactSecretText(description.trim()));
  for (const [key, value] of Object.entries(details)) {
    if (key === "command" || key === "path") continue;
    body.push(`${key}: ${summarizeValue(redactSecretText(formatValue(value)))}`);
  }

  const content = [...head, ...body]
    .flatMap((line) => (line ? wrapDisplayText(line, width) : [""]))
    .map(overlayLine);
  const options = APPROVAL_OPTIONS.map((option, index) =>
    highlightSelection(`  ${option}`, index === selectedIndex),
  );
  const tail = [overlayLine(""), ...options, overlayLine(""), overlayLine(APPROVAL_HINT)];

  const limit = capacity === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(capacity));
  if (content.length + tail.length <= limit) return [...content, ...tail];
  // The options and the hint are the part the dialog cannot do without; the details give way.
  // Before this, a long `content` argument pushed the four options and the hint out of the window.
  const detailBudget = limit - tail.length;
  if (detailBudget < 1) return [options[selectedIndex] ?? overlayLine(APPROVAL_HINT), overlayLine(APPROVAL_HINT)];
  const kept = content.slice(0, detailBudget - 1);
  return [...kept, overlayLine(`… (+${content.length - kept.length} more lines)`), ...tail];
}

/** Collapse a long argument value to its head plus a size note, so one field cannot flood the dialog. */
function summarizeValue(text: string): string {
  const lines = text.split(/\r?\n/);
  if (text.length <= VALUE_MAX_CHARS && lines.length <= VALUE_MAX_LINES) return text;
  const kept = lines.slice(0, VALUE_MAX_LINES - 1);
  const head = kept.join("\n").slice(0, VALUE_MAX_CHARS);
  const omittedLines = lines.length - kept.length;
  const size = `${text.length} chars${lines.length > 1 ? `, ${lines.length} lines` : ""}`;
  const omitted = omittedLines > 0 ? `${omittedLines} more lines, ${size}` : size;
  return `${head}${head ? " " : ""}… (${omitted})`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
