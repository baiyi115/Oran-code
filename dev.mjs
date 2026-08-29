import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const packageRequire = createRequire(pathToFileURL(resolve(root, "packages/oran-code/package.json")));
const tsxApi = pathToFileURL(packageRequire.resolve("tsx/esm/api")).href;
const entryPoint = resolve(root, "packages/oran-code/src/cli.ts");

const { tsImport } = await import(tsxApi);
const { runCli } = await tsImport(pathToFileURL(entryPoint).href, import.meta.url);
await runCli(process.argv.slice(2));
