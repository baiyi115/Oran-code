import test from "node:test";
import assert from "node:assert/strict";
import { listUsers } from "../dist/index.js";

test("keeps explicit offset behavior", () => {
  assert.deepEqual(listUsers({ offset: 2, page: 1, pageSize: 2 }).map((user) => user.id), [3, 4]);
  assert.deepEqual(listUsers({ offset: 0, page: 3, pageSize: 1 }).map((user) => user.id), [1]);
});

test("keeps validation behavior", () => {
  assert.throws(() => listUsers({ page: 0 }), RangeError);
  assert.throws(() => listUsers({ offset: -1 }), RangeError);
  assert.throws(() => listUsers({ pageSize: 1.5 }), RangeError);
});
