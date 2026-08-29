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
const products = [
  { id: "a", name: "Alpha", reorderPoint: 3 },
  { id: "b", name: "Beta", reorderPoint: 2 },
  { id: "c", name: "Gamma", reorderPoint: 1 },
];
const report = mod.buildInventoryReport(products, [
  { productId: "a", onHand: 10, reserved: 4 },
  { productId: "b", onHand: 3, reserved: 2 },
  { productId: "c", onHand: 0, reserved: 0 },
]);
assert.equal(report.totalAvailable, 7);
assert.deepEqual(
  report.lines.map((line) => [line.product.id, line.availableUnits, line.state]),
  [
    ["a", 6, "available"],
    ["b", 1, "low"],
    ["c", 0, "out"],
  ],
);
assert.deepEqual(report.outOfStockIds, ["c"]);
console.log("hidden verification passed");
