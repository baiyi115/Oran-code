import type { ProviderOption } from "./types.js";
import { highlightSelection } from "./overlay/select-list.js";
import { truncateVisible, visibleWidth } from "./text-width.js";

/** 供应商列表与删除确认 overlay 的渲染。 */

export function providersListLines(options: readonly ProviderOption[], selectedIndex: number, width: number): string[] {
  const current = options.find((option) => option.isCurrent);
  const lines: string[] = [
    truncateVisible(`Providers · Current: ${current?.name ?? "(none)"}`, Math.max(1, width)),
    "─".repeat(Math.max(1, width)),
    "Enter Edit   A Add   D Delete   Esc Close",
    "",
  ];
  if (!options.length) lines.push("  (no providers configured)");
  options.forEach((option, index) => {
    lines.push(highlightSelection(`  ${providerOptionLabel(option, Math.max(1, width - 4))}`, index === selectedIndex));
  });
  // 末行固定为新增入口,选中它按 Enter/A 都会打开空白向导。
  lines.push(highlightSelection("  + Add provider", selectedIndex === options.length));
  return lines;
}

export function providerDeleteConfirmLines(providerName: string, selectedIndex: number, width: number): string[] {
  return [
    "Delete provider?",
    `  ${truncateVisible(providerName, Math.max(1, width - 2))}`,
    "─".repeat(Math.max(1, width)),
    "Enter/D Confirm   Esc Cancel",
    "",
    highlightSelection("  Delete", selectedIndex === 0),
    highlightSelection("  Cancel", selectedIndex === 1),
  ];
}

function providerOptionLabel(option: ProviderOption, width: number): string {
  const marker = option.isCurrent ? "● " : "  ";
  const metadata = `${option.protocol} · ${option.modelCount} model${option.modelCount === 1 ? "" : "s"}`;
  const fixedWidth = visibleWidth(marker) + visibleWidth(metadata) + 2;
  const available = Math.max(1, width);
  if (available >= fixedWidth + 8) {
    const name = truncateVisible(option.name, available - fixedWidth);
    const url = truncateVisible(option.baseURL, Math.max(1, available - visibleWidth(marker) - visibleWidth(name) - 2));
    return `${marker}${name}  ${url}  ${metadata}`;
  }
  return `${marker}${truncateVisible(option.name, Math.max(1, available - visibleWidth(marker)))}`;
}
