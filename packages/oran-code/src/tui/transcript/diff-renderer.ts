import { stripTerminalMarkup, wrapDisplayText } from "../text-width.js";
import { ANSI } from "../theme.js";

export function renderDiff(value: string, width: number, expanded: boolean): string[] {
  const lines = stripTerminalMarkup(value).replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  // 折叠态显示前 6 行;扩展态(details)给头尾各一段,避免长 diff 的尾部改动看不到。
  const head = expanded ? 20 : 6;
  const tail = expanded ? 8 : 0;
  const shown =
    lines.length <= head + tail ? lines : [...lines.slice(0, head), undefined, ...lines.slice(lines.length - tail)];
  const output: string[] = [];
  for (const line of shown) {
    if (line === undefined) {
      output.push(`${ANSI.gray}  ... ${lines.length - head - tail} lines hidden (PageUp/PageDown in details) ...${ANSI.reset}`);
      continue;
    }
    const metadata = line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ");
    const kind =
      !metadata && line.startsWith("+") ? "addition" : !metadata && line.startsWith("-") ? "deletion" : "context";
    const marker = kind === "addition" ? "+ " : kind === "deletion" ? "- " : "  ";
    const color = kind === "addition" ? ANSI.green : kind === "deletion" ? ANSI.red : "";
    const body = kind === "context" ? line : line.slice(1);
    output.push(
      ...wrapDisplayText(`${marker}${body}`, width).map((wrapped) =>
        color ? `${color}${wrapped}${ANSI.reset}` : wrapped,
      ),
    );
  }
  return output;
}
