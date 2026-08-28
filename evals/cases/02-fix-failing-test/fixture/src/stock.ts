import type { ProductStock } from './types.js';

export function stockIndex(rows: readonly ProductStock[]): Map<string, ProductStock> {
  const index = new Map<string, ProductStock>();
  for (const row of rows) {
    if (row.onHand < 0 || row.reserved < 0) throw new Error('stock values cannot be negative');
    if (index.has(row.sku)) throw new Error(`duplicate stock row: ${row.sku}`);
    index.set(row.sku, row);
  }
  return index;
}

export function allocatableUnits(stock: ProductStock): number {
  return stock.onHand;
}
