import test from "node:test";
import assert from "node:assert/strict";
import { findUser, listActiveUserSummaries } from "../dist/index.js";

test("keeps lookup and active-user behavior", () => {
  assert.equal(findUser("u-200")?.id, "u-200");
  assert.equal(findUser("missing"), undefined);
  assert.deepEqual(
    listActiveUserSummaries().map((user) => user.id),
    ["u-100", "u-300"],
  );
});
