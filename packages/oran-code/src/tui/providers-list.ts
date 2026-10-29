import type { ProviderOption } from "./types.js";
import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible, visibleWidth } from "./text-width.js";
import { dimHorizontalRule } from "./theme.js";

/** Rendering for the provider list and delete-confirmation overlays. */

export function providersListLines(
  options: readonly ProviderOption[],
  selectedIndex: number,
  width: number,
): OverlayLine[] {
  const current = options.find((option) => option.isCurrent);
  const rowCount = options.length + 1; // the trailing "add" row
  const position = rowCount >= 8 ? ` · ${Math.min(selectedIndex + 1, rowCount)}/${rowCount}` : "";
  const lines: OverlayLine[] = [
    overlayLine(truncateVisible(`Providers · Current: ${current?.name ?? "(none)"}`, Math.max(1, width))),
    overlayLine(dimHorizontalRule(Math.max(1, width))),
    overlayLine(truncateVisible(`↑↓ Select   Enter Edit   A Add   D Delete   Esc Close${position}`, Math.max(1, width))),
    overlayLine(""),
  ];
  if (!options.length) lines.push(overlayLine("  (no providers configured)"));
  options.forEach((option, index) => {
    lines.push(
      highlightSelection(`  ${providerOptionLabel(option, Math.max(1, width - 4))}`, index === selectedIndex),
    );
  });
  // The last row is always the add entry; Enter/A on it opens a blank wizard.
  lines.push(highlightSelection("  + Add provider", selectedIndex === options.length));
  return lines;
}

export function providerDeleteConfirmLines(
  providerName: string,
  selectedIndex: number,
  width: number,
): OverlayLine[] {
  return [
    overlayLine("Delete provider?"),
    overlayLine(`  ${truncateVisible(providerName, Math.max(1, width - 2))}`),
    overlayLine(dimHorizontalRule(Math.max(1, width))),
    overlayLine("←→ Select   Enter Confirm   Esc Cancel"),
    overlayLine(""),
    highlightSelection("  Delete", selectedIndex === 0),
    highlightSelection("  Cancel", selectedIndex === 1),
  ];
}

function providerOptionLabel(option: ProviderOption, width: number): string {
  const available = Math.max(1, width);
  const marker = option.isCurrent ? "● " : "  ";
  const metadata = `${option.protocol} · ${option.modelCount} model${option.modelCount === 1 ? "" : "s"}`;
  const markerWidth = visibleWidth(marker);
  // Name and URL share whatever the fixed parts leave. Handing the name the whole remainder (as
  // this used to) pushed the row past the overlay width by the URL plus its two separators.
  const remaining = available - markerWidth - visibleWidth(metadata) - 4;
  if (remaining >= 16) {
    const nameBudget = Math.max(8, Math.floor(remaining * 0.4));
    const name = truncateVisible(option.name, nameBudget);
    const url = truncateVisible(option.baseURL, remaining - nameBudget);
    return `${marker}${name}  ${url}  ${metadata}`;
  }
  return `${marker}${truncateVisible(option.name, Math.max(1, available - markerWidth))}`;
}
