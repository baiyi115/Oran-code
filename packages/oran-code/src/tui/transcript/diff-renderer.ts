import { stripTerminalMarkup, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";

export function renderDiff(value: string, width: number, expanded: boolean): string[] {
  const lines = stripTerminalMarkup(value).replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  const limit = expanded ? 24 : 6;
  const output = lines.slice(0, limit).flatMap((line) => {
    const metadata = line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ");
    const kind =
      !metadata && line.startsWith("+") ? "addition" : !metadata && line.startsWith("-") ? "deletion" : "context";
    const marker = kind === "addition" ? "+ " : kind === "deletion" ? "- " : "  ";
    const color = kind === "addition" ? ANSI.green : kind === "deletion" ? ANSI.red : "";
    const body = kind === "context" ? line : line.slice(1);
    return wrapDisplayText(`${marker}${body}`, width).map((wrapped) =>
      color ? `${color}${wrapped}${ANSI.reset}` : wrapped,
    );
  });
  if (lines.length > limit) output.push(`${ANSI.gray}  ... ${lines.length - limit} more diff lines${ANSI.reset}`);
  return output;
}
