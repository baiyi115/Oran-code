import { stripTerminalMarkup, truncateVisible, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";

/**
 * Renders unified diff text for the details view: colored `+`/`-` rows, gray hunk headers, wrapped
 * to the row width. The transcript row itself shows only the heading and its change counts, so this
 * runs where the user asked for the change and the surrounding view can scroll.
 */
export function renderDiff(value: string, width: number): string[] {
  const lines = stripTerminalMarkup(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  // The generator caps its own output; a diff rebuilt from a raw apply_patch argument has no such
  // bound, so the renderer keeps a ceiling of its own.
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const output: string[] = [];
  for (const line of shown) {
    // Hunk and file headers carry the position, not content: showing them as changed lines would
    // misrepresent both the counts and the change itself.
    if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      output.push(`${ANSI.gray}${truncateVisible(line, Math.max(1, width))}${ANSI.reset}`);
      continue;
    }
    const kind = line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "context";
    const marker = kind === "addition" ? "+ " : kind === "deletion" ? "- " : "  ";
    const color = kind === "addition" ? ANSI.green : kind === "deletion" ? ANSI.red : "";
    const body = kind === "context" ? line.replace(/^ /, "") : line.slice(1);
    output.push(
      ...wrapDisplayText(`${marker}${body}`, width).map((wrapped) =>
        color ? `${color}${wrapped}${ANSI.reset}` : wrapped,
      ),
    );
  }
  if (shown.length < lines.length) {
    output.push(`${ANSI.gray}  ... ${lines.length - shown.length} lines hidden ...${ANSI.reset}`);
  }
  return output;
}

const MAX_RENDERED_LINES = 400;
