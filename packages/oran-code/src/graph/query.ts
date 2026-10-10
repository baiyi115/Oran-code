import type { GraphIndex, SymbolNode } from "./languages/registry.js";

/**
 * Query layer: reverse traversal over the forward import edges, computed at
 * call time (never persisted, so it cannot drift out of sync). The visited
 * set keeps cycles from expanding forever.
 */

export interface ImpactedFile {
  path: string;
  /** 1 = direct dependent, n = n-th layer. */
  distance: number;
}

export function dependents(index: GraphIndex, target: string, depth: number): ImpactedFile[] {
  const dependentsOf = buildReverseIndex(index);
  const found = new Map<string, number>();
  let frontier = new Set<string>(dependentsOf.get(target) ?? []);
  const visited = new Set<string>([target]);

  for (let distance = 1; distance <= depth && frontier.size > 0; distance += 1) {
    const next = new Set<string>();
    for (const path of frontier) {
      if (visited.has(path)) continue;
      visited.add(path);
      if (!found.has(path)) found.set(path, distance);
      for (const parent of dependentsOf.get(path) ?? []) {
        if (!visited.has(parent)) next.add(parent);
      }
    }
    frontier = next;
  }
  return [...found.entries()]
    .map(([path, distance]) => ({ path, distance }))
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path));
}

const TEST_FILE_PATTERNS: RegExp[] = [
  /(?:^|\/)(?:tests?|__tests__)\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)test_[^/]+\.py$/,
  /(?:^|\/)[^/]+_test\.go$/,
];

export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

export function symbolsInFile(index: GraphIndex, path: string): SymbolNode[] {
  return (index.symbols ?? []).filter((symbol) => symbol.file === path);
}

export interface CallerEntry {
  caller: string;
  callerFile: string;
  callee: string;
  calleeFile: string;
}

/** Statically determined callers, optionally limited to one symbol name. */
export function callers(index: GraphIndex, symbolName?: string): CallerEntry[] {
  const entries: CallerEntry[] = [];
  for (const edge of index.calls ?? []) {
    const calleeName = edge.to.slice(edge.to.lastIndexOf("#") + 1);
    if (symbolName && calleeName !== symbolName) continue;
    entries.push({
      caller: edge.from,
      callerFile: edge.from.slice(0, edge.from.lastIndexOf("#")),
      callee: edge.to,
      calleeFile: edge.to.slice(0, edge.to.lastIndexOf("#")),
    });
  }
  return entries.sort(
    (left, right) => left.callerFile.localeCompare(right.callerFile) || left.caller.localeCompare(right.caller),
  );
}

function buildReverseIndex(index: GraphIndex): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of Object.entries(index.imports)) {
    for (const target of targets) {
      const bucket = reverse.get(target);
      if (bucket) {
        if (!bucket.includes(from)) bucket.push(from);
      } else {
        reverse.set(target, [from]);
      }
    }
  }
  return reverse;
}
