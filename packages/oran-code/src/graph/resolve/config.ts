import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigSnapshot } from "../languages/registry.js";

/**
 * Build-config snapshots loaded once per build. Each parser is deliberately
 * minimal: it extracts only what file resolution needs, and anything it
 * cannot understand simply stays absent (resolutions then report
 * needs-config / external instead of guessing).
 */

export async function loadConfigSnapshot(root: string): Promise<ConfigSnapshot> {
  const [goMod, cargo, composer, pubspec] = await Promise.all([
    readText(join(root, "go.mod")),
    readText(join(root, "Cargo.toml")),
    readText(join(root, "composer.json")),
    readText(join(root, "pubspec.yaml")),
  ]);

  const config: ConfigSnapshot = {};
  if (goMod) {
    const match = /^module\s+(\S+)\s*$/m.exec(goMod);
    if (match) config.goModulePath = match[1];
  }
  if (cargo) parseCargo(config, cargo);
  if (composer) parseComposer(config, composer);
  if (pubspec) parsePubspec(config, pubspec);
  return config;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Path dependencies from any dependency table; crate root from src/lib.rs or src/main.rs. */
function parseCargo(config: ConfigSnapshot, toml: string): void {
  const deps = new Map<string, string>();
  const entry = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*?path\s*=\s*"([^"]+)"/gm;
  for (let match = entry.exec(toml); match; match = entry.exec(toml)) {
    const crate = match[1];
    const path = match[2]?.replaceAll("\\", "/").replace(/\/$/, "");
    if (crate && path) deps.set(crate, path);
  }
  if (deps.size > 0) config.cargoPathDeps = deps;
}

function parseComposer(config: ConfigSnapshot, json: string): void {
  try {
    const parsed = JSON.parse(json) as { autoload?: { "psr-4"?: Record<string, string | string[]> } };
    const psr4 = new Map<string, string[]>();
    for (const [prefix, dirs] of Object.entries(parsed.autoload?.["psr-4"] ?? {})) {
      psr4.set(prefix.replaceAll("\\", "/").replace(/\/$/, ""), (Array.isArray(dirs) ? dirs : [dirs]).map((dir) => dir.replaceAll("\\", "/").replace(/\/$/, "")));
    }
    if (psr4.size > 0) config.composerPsr4 = psr4;
  } catch {
    // Malformed composer.json: psr-4 stays absent.
  }
}

function parsePubspec(config: ConfigSnapshot, yaml: string): void {
  const match = /^name:\s*(\S+)\s*$/m.exec(yaml);
  if (match) config.dartPackageName = match[1];
}
