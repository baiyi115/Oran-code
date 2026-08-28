import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = process.argv[2] ? path.resolve(process.argv[2]) : '';
assert.ok(workspace && path.isAbsolute(workspace), 'usage: node verify.mjs <absolute-workspace-path>');
const caseDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(caseDir, 'fixture');
const protectedPaths = ['package.json', 'tsconfig.json', 'AGENTS.md', 'pnpm-workspace.yaml'];

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
async function collectTests(dir, prefix = 'tests') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}
for (const rel of [...protectedPaths, ...await collectTests(path.join(fixtureDir, 'tests'))]) {
  assert.equal(await digest(path.join(workspace, rel)), await digest(path.join(fixtureDir, rel)), `protected file changed: ${rel}`);
}

const mod = await import(pathToFileURL(path.join(workspace, 'dist/index.js')).href + `?v=${Date.now()}`);
const result = mod.allocateOrder(
  [
    { sku: 'pen', onHand: 8, reserved: 3 },
    { sku: 'paper', onHand: 2, reserved: 5 },
    { sku: 'clip', onHand: 4, reserved: 0 },
  ],
  [
    { sku: 'pen', quantity: 6 },
    { sku: 'paper', quantity: 1 },
    { sku: 'clip', quantity: 4 },
  ],
);
assert.equal(result.complete, false);
assert.deepEqual(result.lines, [
  { sku: 'pen', requested: 6, allocated: 5 },
  { sku: 'paper', requested: 1, allocated: 0 },
  { sku: 'clip', requested: 4, allocated: 4 },
]);
assert.deepEqual(result.missingSkus, ['pen', 'paper']);
assert.equal(mod.allocationSummary(result), 'Partial allocation - pen: 5/6, paper: 0/1');
console.log('hidden verification passed');
