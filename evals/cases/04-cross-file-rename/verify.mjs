import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
assert.ok(workspace && path.isAbsolute(workspace), "Expected an absolute workspace path");

const entry = path.join(workspace, "dist", "index.js");
const api = await import(`${pathToFileURL(entry).href}?verify=${Date.now()}`);

assert.deepEqual(api.findUser("u-100"), { id: "u-100", username: "amber", active: true });
assert.deepEqual(api.getUserSummary("u-200"), { id: "u-200", username: "birch" });
assert.deepEqual(api.listActiveUserSummaries(), [
  { id: "u-100", username: "amber" },
  { id: "u-300", username: "cedar" }
]);
assert.equal(api.findUser("missing"), undefined);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

const sourceFiles = (await collectFiles(path.join(workspace, "src"))).filter((file) => file.endsWith(".ts"));
const declarationFiles = (await collectFiles(path.join(workspace, "dist"))).filter((file) => file.endsWith(".d.ts"));
const text = (await Promise.all([...sourceFiles, ...declarationFiles].map((file) => readFile(file, "utf8")))).join("\n");
assert.match(text, /\busername\b/, "The new username field must be present in source and declarations");
assert.doesNotMatch(text, /\balias\b/, "The old alias field must be removed consistently");

console.log("hidden verification passed: cross-file rename is consistent");
