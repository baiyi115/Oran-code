import { highlightSelection, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible } from "./text-width.js";

export function modelSelectorLines(
  models: readonly string[],
  selectedIndex: number,
  width = 80,
): OverlayLine[] {
  return models.map((model, index) =>
    highlightSelection(`  ${truncateVisible(model, Math.max(1, width - 2))}`, index === selectedIndex),
  );
}
