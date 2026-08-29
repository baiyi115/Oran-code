export type StockState = "available" | "low" | "out";

export interface Product {
  id: string;
  name: string;
  reorderPoint: number;
}

export interface StockRecord {
  productId: string;
  onHand: number;
  reserved: string;
}

export interface InventoryLine {
  product: Product;
  availableUnits: number;
  state: StockState;
}

export interface InventoryReport {
  lines: InventoryLine[];
  totalAvailable: number;
  outOfStockIds: string[];
}
