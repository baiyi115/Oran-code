import { highlightSelection } from "./overlay/select-list.js";

export function modelSelectorLines(models: readonly string[], selectedIndex: number): string[] {
  return models.map((model, index) => highlightSelection(`  ${model}`, index === selectedIndex));
}
