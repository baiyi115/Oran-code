import test from "node:test";
import assert from "node:assert/strict";
import { buildInventoryReport, formatInventoryReport } from "../dist/index.js";

const products = [
  { id: "tea", name: "Tea", reorderPoint: 2 },
  { id: "cake", name: "Cake", reorderPoint: 1 },
];

test("summarizes available inventory without going below zero", () => {
  const report = buildInventoryReport(products, [
    { productId: "tea", onHand: 7, reserved: 2 },
    { productId: "cake", onHand: 1, reserved: 3 },
  ]);
  assert.equal(report.totalAvailable, 5);
  assert.deepEqual(report.outOfStockIds, ["cake"]);
  assert.ok(formatInventoryReport(report).includes("Tea: 5 (available)"));
});
