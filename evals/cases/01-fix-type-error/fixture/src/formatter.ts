import type { InventoryReport } from './types.js';

export function formatInventoryReport(report: InventoryReport): string {
  const rows = report.lines.map((line) =>
    `${line.product.name}: ${line.availableUnits} (${line.state})`,
  );
  rows.push(`Total available: ${report.totalAvailable}`);
  if (report.outOfStockIds.length > 0) rows.push(`Out of stock: ${report.outOfStockIds.join(', ')}`);
  return rows.join('\n');
}
