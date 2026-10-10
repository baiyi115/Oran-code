import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * How to start one of the NDJSON child hosts (the graph's parse host, the search
 * host).
 *
 * The built entry is preferred, because the tsx loader does not propagate to child
 * processes either — a host started with `--import tsx` pays for the loader, and a
 * published install has no sources to load. `moduleDirectory` is the caller's own
 * directory, so the entry sits next to the module that spawns it.
 */
export function childHostCommand(moduleDirectory: string, entryName: string): { command: string; args: string[] } {
  const distEntry = join(moduleDirectory, `${entryName}.js`);
  if (existsSync(distEntry)) return { command: process.execPath, args: [distEntry] };
  return { command: process.execPath, args: ["--import", "tsx", join(moduleDirectory, `${entryName}.ts`)] };
}
