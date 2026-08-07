import { stripTerminalMarkup, wrapDisplayText } from "../text-width.js";

export function renderDiff(value: string, width: number, expanded: boolean): string[] {
  const lines = stripTerminalMarkup(value).replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  const limit = expanded ? 24 : 6;
  const output = lines.slice(0, limit).flatMap((line) => {
    const marker = line.startsWith("+") ? "+ " : line.startsWith("-") ? "- " : "  ";
    return wrapDisplayText(`${marker}${line.slice(1)}`, width);
  });
  if (lines.length > limit) output.push(`  ... ${lines.length - limit} more diff lines`);
  return output;
}
