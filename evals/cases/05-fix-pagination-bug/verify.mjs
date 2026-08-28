import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
assert.ok(workspace && path.isAbsolute(workspace), "Expected an absolute workspace path");

const entry = path.join(workspace, "dist", "index.js");
const { listUsers } = await import(`${pathToFileURL(entry).href}?verify=${Date.now()}`);
const ids = (input) => listUsers(input).map((user) => user.id);

assert.deepEqual(ids(), [1, 2], "Default pagination must return the first page");
assert.deepEqual(ids({ page: 1, pageSize: 2 }), [1, 2]);
assert.deepEqual(ids({ page: 2, pageSize: 2 }), [3, 4]);
assert.deepEqual(ids({ page: 3, pageSize: 2 }), [5, 6]);
assert.deepEqual(ids({ page: 2, pageSize: 3 }), [4, 5, 6]);
assert.deepEqual(ids({ page: 10, pageSize: 2 }), []);

assert.deepEqual(ids({ offset: 0, page: 3, pageSize: 2 }), [1, 2], "Explicit offset must take precedence");
assert.deepEqual(ids({ offset: 1, page: 1, pageSize: 3 }), [2, 3, 4]);
assert.deepEqual(ids({ offset: 6, pageSize: 2 }), []);

assert.throws(() => listUsers({ page: 0 }), RangeError);
assert.throws(() => listUsers({ page: -1 }), RangeError);
assert.throws(() => listUsers({ page: 1.5 }), RangeError);
assert.throws(() => listUsers({ pageSize: -1 }), RangeError);
assert.throws(() => listUsers({ pageSize: 1.5 }), RangeError);
assert.throws(() => listUsers({ offset: -1 }), RangeError);
assert.throws(() => listUsers({ offset: 1.5 }), RangeError);

console.log("hidden verification passed: pagination boundaries and offset compatibility are correct");
