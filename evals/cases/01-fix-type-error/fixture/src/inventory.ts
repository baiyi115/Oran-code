import { indexProducts, requireProduct } from "./catalog.js";
import type { InventoryLine, InventoryReport, Product, StockRecord, StockState } from "./types.js";

function stateFor(available: number, reorderPoint: number): StockState {
  if (available === 0) return "out";
  if (available <= reorderPoint) return "low";
  return "available";
}

export function buildInventoryReport(products: readonly Product[], records: readonly StockRecord[]): InventoryReport {
  const catalog = indexProducts(products);
  const lines: InventoryLine[] = records.map((record) => {
    const product = requireProduct(catalog, record.productId);
    const availableUnits = Math.max(0, record.onHand - record.reserved);
    return {
      product,
      availableUnits,
      state: stateFor(availableUnits, product.reorderPoint),
    };
  });

  return {
    lines,
    totalAvailable: lines.reduce((sum, line) => sum + line.availableUnits, 0),
    outOfStockIds: lines.filter((line) => line.state === "out").map((line) => line.product.id),
  };
}
