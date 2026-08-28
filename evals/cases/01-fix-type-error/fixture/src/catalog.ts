import type { Product } from './types.js';

export function indexProducts(products: readonly Product[]): Map<string, Product> {
  const index = new Map<string, Product>();
  for (const product of products) {
    if (index.has(product.id)) throw new Error(`duplicate product id: ${product.id}`);
    index.set(product.id, product);
  }
  return index;
}

export function requireProduct(index: ReadonlyMap<string, Product>, id: string): Product {
  const product = index.get(id);
  if (!product) throw new Error(`unknown product: ${id}`);
  return product;
}
