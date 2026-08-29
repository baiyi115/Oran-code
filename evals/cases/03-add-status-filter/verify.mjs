import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = process.argv[2] ? path.resolve(process.argv[2]) : "";
assert.ok(workspace && path.isAbsolute(workspace), "usage: node verify.mjs <absolute-workspace-path>");
const caseDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(caseDir, "fixture");
const protectedPaths = ["package.json", "tsconfig.json", "AGENTS.md", "pnpm-workspace.yaml"];

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
async function collectTests(dir, prefix = "tests") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTests(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}
for (const rel of [...protectedPaths, ...(await collectTests(path.join(fixtureDir, "tests")))]) {
  assert.equal(
    await digest(path.join(workspace, rel)),
    await digest(path.join(fixtureDir, rel)),
    `protected file changed: ${rel}`,
  );
}

const mod = await import(pathToFileURL(path.join(workspace, "dist/index.js")).href + `?v=${Date.now()}`);
const customers = [
  { id: "3", name: "Gamma Active", email: "g@x.test", status: "active", createdAt: "2026-03-01" },
  { id: "1", name: "Alpha Active", email: "a@x.test", status: "active", createdAt: "2026-01-01" },
  { id: "2", name: "Beta Paused", email: "b@x.test", status: "paused", createdAt: "2026-02-01" },
  { id: "4", name: "Archived Alpha", email: "old@x.test", status: "closed", createdAt: "2026-04-01" },
];
const service = new mod.CustomerService(new mod.MemoryCustomerRepository(customers));
const active = service.listCustomers({ status: "active" });
assert.equal(active.total, 2);
assert.deepEqual(
  active.items.map((customer) => customer.id),
  ["1", "3"],
);
const combined = service.listCustomers({ status: "active", keyword: "gamma", offset: 0, limit: 10 });
assert.equal(combined.total, 1);
assert.deepEqual(
  combined.items.map((customer) => customer.id),
  ["3"],
);
const closed = service.listCustomers({ status: "closed" });
assert.deepEqual(
  closed.items.map((customer) => customer.id),
  ["4"],
);
const unchanged = service.listCustomers({ offset: 1, limit: 2 });
assert.equal(unchanged.total, 4);
assert.deepEqual(
  unchanged.items.map((customer) => customer.id),
  ["2", "3"],
);
console.log("hidden verification passed");
