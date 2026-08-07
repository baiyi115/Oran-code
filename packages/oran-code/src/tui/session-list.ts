import type { SessionOption } from "./types.js";
import { truncateVisible, visibleWidth } from "./text-width.js";

export function currentSessionLine(options: readonly SessionOption[], width: number): string {
  const current = options.find((option) => option.isCurrent);
  return truncateVisible(`Sessions · Current: ${current?.name ?? "(unavailable)"}`, Math.max(1, width));
}

export function sessionOptionLabel(option: SessionOption, width: number): string {
  const available = Math.max(1, width);
  const marker = option.isCurrent ? "● current " : "  ";
  const metadata = `${formatSessionTime(option.updatedAt)} · ${option.messageCount} msgs`;
  const fixedWidth = visibleWidth(marker) + 2 + visibleWidth(metadata);
  if (available >= fixedWidth + 8) {
    const name = truncateVisible(option.name, available - fixedWidth);
    return `${marker}${name}  ${metadata}`;
  }
  return `${marker}${truncateVisible(option.name, Math.max(1, available - visibleWidth(marker)))}`;
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
