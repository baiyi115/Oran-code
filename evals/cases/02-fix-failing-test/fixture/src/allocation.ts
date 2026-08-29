import { allocatableUnits, stockIndex } from "./stock.js";
import type { AllocationLine, AllocationResult, OrderLine, ProductStock } from "./types.js";

export function allocateOrder(stockRows: readonly ProductStock[], orderLines: readonly OrderLine[]): AllocationResult {
  const stocks = stockIndex(stockRows);
  const allocations: AllocationLine[] = [];

  for (const line of orderLines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new Error("quantity must be positive");
    const stock = stocks.get(line.sku);
    if (!stock) throw new Error(`unknown sku: ${line.sku}`);
    allocations.push({
      sku: line.sku,
      requested: line.quantity,
      allocated: Math.min(line.quantity, allocatableUnits(stock)),
    });
  }

  const missingSkus = allocations.filter((line) => line.allocated < line.requested).map((line) => line.sku);
  return { complete: missingSkus.length === 0, lines: allocations, missingSkus };
}
