import test from "node:test";
import assert from "node:assert/strict";
import { CustomerService, MemoryCustomerRepository } from "../dist/index.js";

const customers = [
  { id: "c2", name: "Beta Studio", email: "team@beta.test", status: "paused", createdAt: "2026-02-01" },
  { id: "c1", name: "Alpha Labs", email: "hello@alpha.test", status: "active", createdAt: "2026-01-01" },
  { id: "c3", name: "Old Alpha", email: "old@example.test", status: "closed", createdAt: "2026-03-01" },
];
const service = new CustomerService(new MemoryCustomerRepository(customers));

test("keeps keyword search, stable ordering and pagination", () => {
  const page = service.listCustomers({ keyword: "alpha", offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.items.map((customer) => customer.id),
    ["c3"],
  );
});

test("returns all customers when no filter is supplied", () => {
  assert.deepEqual(
    service.listCustomers().items.map((customer) => customer.id),
    ["c1", "c2", "c3"],
  );
});
