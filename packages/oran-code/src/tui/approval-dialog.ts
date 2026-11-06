import type { ToolCall } from "../types.js";
import { redactSecretText } from "../formatting.js";
import { redactSecrets } from "./interaction.js";
import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible, wrapDisplayTextLimited } from "./text-width.js";
import { subagentOriginLabel, type SubagentOrigin } from "../subagent/types.js";

const APPROVAL_OPTIONS = ["Allow rule for this task", "Allow once", "Save rule for this project", "Reject"] as const;

/**
 * "Allow once" is the default: the dialog pops up while the user is still typing, so Enter must not
 * hand over a standing permission nobody asked for — and `y` (the quick answer) resolves to the
 * same option, so the default and the hint agree.
 */
export const APPROVAL_DEFAULT_INDEX = 1;

const APPROVAL_HINT = "↑↓ Select   Enter Confirm   v Details   y Allow once   n/Esc Reject";
/** Argument values longer than this are summarized: the dialog is for orientation, not for review. */
const VALUE_MAX_CHARS = 200;
const VALUE_MAX_LINES = 4;
const FIELD_MAX_LINES = 3;

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
  // Bound each field before fitting the dialog: a command and its rule can each contain an
  // entire script. The full, redacted values remain available through the details view.
  const content = approvalContentLines(call, level, description, workspace, origin, true)
    .flatMap((line) => (line ? wrapDisplayTextLimited(line, width, FIELD_MAX_LINES) : [""]))
    .map(overlayLine);
  const options = APPROVAL_OPTIONS.map((option, index) =>
    highlightSelection(truncateVisible(`  ${option}`, Math.max(1, width)), index === selectedIndex),
  );
  const hint = overlayLine(truncateVisible(APPROVAL_HINT, Math.max(1, width)));
  const tail = [overlayLine(""), ...options, overlayLine(""), hint];

  const limit = capacity === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(capacity));
  if (content.length + tail.length <= limit) return [...content, ...tail];
  const detailBudget = limit - tail.length;
  if (detailBudget < 1) return limit === 1 ? [options[selectedIndex] ?? hint] : [options[selectedIndex] ?? hint, hint];
  const kept = content.slice(0, detailBudget - 1);
  return [...kept, overlayLine(`… (+${content.length - kept.length} more lines)`), ...tail];
}

/** Unabridged, redacted fields for the scrollable details view. */
export function approvalDetailLines(
  call: ToolCall,
  level: number,
  description: string,
  workspace: string,
  origin: SubagentOrigin,
): string[] {
  return approvalContentLines(call, level, description, workspace, origin, false).flatMap((line) =>
    line.split(/\r?\n/),
  );
}

function approvalContentLines(
  call: ToolCall,
  level: number,
  description: string,
  workspace: string,
  origin: SubagentOrigin,
  compact: boolean,
): string[] {
  const details = redactSecrets(call.arguments) as Record<string, unknown>;
  const command = typeof details.command === "string" ? redactSecretText(details.command) : undefined;
  // What the call touches comes before where it came from: that is what the user has to judge.
  const lines = ["Permission required", "", `Tool: ${call.name}`];
  if (command !== undefined) lines.push(`Command: ${command}`);
  if (typeof details.path === "string") lines.push(`Path: ${redactSecretText(details.path)}`);
  lines.push(`Source: ${subagentOriginLabel(origin)}`, `Directory: ${workspace}`, `Permission level: ${level}`);
  if (description.trim()) {
    lines.push("");
    for (const line of redactSecretText(description.trim()).split(/\r?\n/)) {
      // An exact command rule repeats the entire command. Keep its scope explicit without
      // printing a second copy of the script in the compact dialog.
      lines.push(
        compact && command && line === `Rule: ${call.name}(${command.trim()})`
          ? `Rule: ${call.name}(this exact command; v to view full)`
          : line,
      );
    }
  }
  for (const [key, value] of Object.entries(details)) {
    if (key === "command" || key === "path") continue;
    const text = redactSecretText(formatValue(value));
    lines.push(`${key}: ${compact ? summarizeValue(text) : text}`);
  }
  return lines;
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
