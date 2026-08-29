import type { AllocationResult } from "./types.js";

export function allocationSummary(result: AllocationResult): string {
  if (result.complete) return "Order can be fulfilled";
  const details = result.lines
    .filter((line) => line.allocated < line.requested)
    .map((line) => `${line.sku}: ${line.allocated}/${line.requested}`);
  return `Partial allocation - ${details.join(", ")}`;
}
