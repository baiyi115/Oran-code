import { dirname, posix } from "node:path";
import { registerLanguage, type LanguageSupport, type ResolveContext, type ResolveResult } from "./registry.js";

/**
 * Rust. Two specifier channels:
 * - `mod foo;` -> foo.rs / foo/mod.rs next to the declaring file
 * - `use ...`  -> paths anchored at crate::, self::, super::, or (2015-style)
 *   the crate root; bare crate names resolve through Cargo.toml path deps
 *   and otherwise stay external. Inline `mod foo { }` never maps to a file.
 */

const QUERY = ["(mod_item name: (identifier) @mod)", "(use_declaration (scoped_identifier) @spec)", "(use_declaration (identifier) @spec)"].join("\n");

function specFromMatch(captures: ReadonlyMap<string, string>): string[] {
  const mod = captures.get("mod");
  if (mod) {
    // Inline `mod foo { ... }` has a body and never maps to a file.
    const flat = mod.replace(/\s+/g, " ");
    const name = /^mod (\w+)\s*;/.exec(flat)?.[1];
    return name ? [`mod:${name}`] : [];
  }
  const use = captures.get("spec");
  return use ? [`use:${use}`] : [];
}

function resolveIn(dir: string, modulePath: string, fileSet: ReadonlySet<string>): ResolveResult {
  const base = modulePath ? `${dir === "." ? "" : `${dir}/`}${modulePath}` : dir;
  for (const candidate of [`${base}.rs`, `${base}/mod.rs`]) {
    if (fileSet.has(candidate)) return { kind: "resolved", paths: [candidate] };
  }
  return { kind: "unresolved", reason: "no-source" };
}

export function resolveRustSpecifier(fromFile: string, specifier: string, context: ResolveContext): ResolveResult {
  const { fileSet, config } = context;
  const crateRoot = config.rustCrateRoot ?? "src";

  if (specifier.startsWith("mod:")) {
    return resolveIn(posix.dirname(fromFile), specifier.slice(4), fileSet);
  }

  const segments = specifier.slice(4).split("::").filter(Boolean);
  const anchor = segments[0];
  if (!anchor || segments.length === 0) return { kind: "unresolved", reason: "external" };
  const rest = segments.slice(1).join("/");

  // A use path's last segment may be a symbol, not a module: try the full
  // path first, then back off to the parent module.
  const resolvePath = (dir: string, modulePath: string): ResolveResult => {
    if (!modulePath) return { kind: "unresolved", reason: "no-source" };
    const direct = resolveIn(dir, modulePath, fileSet);
    if (direct.kind === "resolved") return direct;
    const parent = modulePath.split("/").slice(0, -1).join("/");
    if (parent) return resolveIn(dir, parent, fileSet);
    return direct;
  };

  if (anchor === "crate") return resolvePath(crateRoot, rest);
  if (anchor === "self") return resolvePath(posix.dirname(fromFile), rest);
  if (anchor === "super") {
    let supers = 0;
    while (segments[supers] === "super") supers += 1;
    let dir = posix.dirname(fromFile);
    for (let level = 1; level < supers; level += 1) dir = dirname(dir);
    return resolvePath(dir, segments.slice(supers).join("/"));
  }

  // 2015-style: a bare first segment may still be a crate-root module.
  const bare = resolvePath(crateRoot, rest ? `${anchor}/${rest}` : anchor);
  if (bare.kind === "resolved") return bare;

  // Cargo.toml path dependency: crate name -> repo directory.
  const depDir = config.cargoPathDeps?.get(anchor);
  if (depDir !== undefined) {
    if (!rest) {
      const files = [...fileSet].filter((file) => file.startsWith(`${depDir}/`) && file.endsWith(".rs")).sort();
      if (files.length > 0) return { kind: "resolved", paths: files };
    } else {
      return resolveIn(depDir, rest, fileSet);
    }
  }
  return { kind: "unresolved", reason: "external" };
}

export function registerRust(): void {
  const support: LanguageSupport = {
    id: "rust",
    extensions: [".rs"],
    grammar: "rust",
    importQuery: QUERY,
    specFromMatch,
    resolve: resolveRustSpecifier,
  };
  registerLanguage(support);
}
