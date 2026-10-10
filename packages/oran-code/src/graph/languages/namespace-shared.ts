import type { ResolveContext, ResolveResult } from "./registry.js";

/** Shared resolution for package/namespace languages (java, kotlin, scala, c#). */

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.\w+$/, "");
}

/** pkg + class name: the public-class-per-file convention, unique match resolves. */
export function resolveClassImport(pkg: string, type: string, context: ResolveContext): ResolveResult {
  const files = context.packageIndex.get(pkg);
  if (!files || files.length === 0) return { kind: "unresolved", reason: "external" };
  const matches = files.filter((file) => basename(file) === type);
  if (matches.length === 1) return { kind: "resolved", paths: matches };
  if (matches.length > 1) return { kind: "unresolved", reason: "ambiguous" };
  return { kind: "unresolved", reason: "no-source" };
}

/** pkg.* : the namespace-level edge — every file declaring the package. */
export function resolveWildcardImport(pkg: string, context: ResolveContext): ResolveResult {
  const files = context.packageIndex.get(pkg);
  if (files && files.length > 0) return { kind: "resolved", paths: [...files].sort() };
  return { kind: "unresolved", reason: "external" };
}

/**
 * Namespace named directly (C# using): resolves only when exactly one file
 * declares it; a namespace spanning many files is inherently ambiguous at
 * file level and says so instead of pretending.
 */
export function resolveNamespaceImport(ns: string, context: ResolveContext): ResolveResult {
  const files = context.packageIndex.get(ns);
  if (!files || files.length === 0) return { kind: "unresolved", reason: "external" };
  if (files.length === 1) return { kind: "resolved", paths: [...files] };
  return { kind: "unresolved", reason: "ambiguous" };
}
