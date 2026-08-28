export interface ProductStock {
  sku: string;
  onHand: number;
  reserved: number;
}

export interface OrderLine {
  sku: string;
  quantity: number;
}

export interface AllocationLine {
  sku: string;
  requested: number;
  allocated: number;
}

export interface AllocationResult {
  complete: boolean;
  lines: AllocationLine[];
  missingSkus: string[];
}
