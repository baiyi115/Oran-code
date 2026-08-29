import test from "node:test";
import assert from "node:assert/strict";
import { allocateOrder, allocationSummary } from "../dist/index.js";

test("does not allocate units already reserved by another order", () => {
  const result = allocateOrder([{ sku: "book", onHand: 5, reserved: 4 }], [{ sku: "book", quantity: 3 }]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.lines, [{ sku: "book", requested: 3, allocated: 1 }]);
  assert.equal(allocationSummary(result), "Partial allocation - book: 1/3");
});

test("rejects an order line for an unknown sku", () => {
  assert.throws(() => allocateOrder([], [{ sku: "missing", quantity: 1 }]), /unknown sku/);
});
