import type { GraphIndex, UnresolvedReason } from "./languages/registry.js";

/**
 * /graph summary: the human-readable projection of the index. Always a
 * summary — full listings do not fit a human or a context window.
 */

export function graphSummary(index: GraphIndex): string {
  const lines: string[] = [];

  const byLanguage = new Map<string, number>();
  for (const language of Object.values(index.languages)) {
    byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
  }
  const edgeCount = Object.values(index.imports).reduce((total, targets) => total + targets.length, 0);
  const distribution = [...byLanguage.entries()].sort().map(([language, count]) => `${language} ${count}`).join(", ");
  lines.push(`Files: ${index.files.length} (${distribution || "no languages"}) · Edges: ${edgeCount} · built ${index.builtAt}`);

  // Most-depended-on files: the highest-risk files to change.
  const depended = new Map<string, number>();
  for (const targets of Object.values(index.imports)) {
    for (const target of targets) depended.set(target, (depended.get(target) ?? 0) + 1);
  }
  const top = [...depended.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10);
  if (top.length > 0) {
    lines.push("Most depended on (highest change risk):");
    for (const [path, count] of top) lines.push(`  ${String(count).padStart(3)}× ${path}`);
  }

  const cyclic = findCyclicFiles(index);
  if (cyclic.length > 0) {
    lines.push(`Cyclic dependencies (${cyclic.length} file(s)):`);
    for (const path of cyclic.slice(0, 20)) lines.push(`  ↻ ${path}`);
  } else {
    lines.push("Cyclic dependencies: none");
  }

  const isolated = index.files.filter((file) => !(index.imports[file]?.length) && !depended.has(file));
  if (isolated.length > 0) {
    lines.push(`Isolated files (no imports in or out): ${isolated.length}`);
    for (const path of isolated.slice(0, 20)) lines.push(`  · ${path}`);
  }

  const byReason = new Map<UnresolvedReason, number>();
  for (const entries of Object.values(index.unresolved)) {
    for (const entry of entries) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  const reasonSummary = [...byReason.entries()].sort().map(([reason, count]) => `${count} ${reason}`).join(", ");
  lines.push(`Unresolved specifiers: ${reasonSummary || "0"}`);
  return lines.join("\n");
}

/** Files participating in at least one import cycle (iterative DFS, back-edge collection). */
function findCyclicFiles(index: GraphIndex): string[] {
  const color = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const cyclic = new Set<string>();
  const path: string[] = [];
  const pathIndex = new Map<string, number>();

  const visit = (start: string): void => {
    const stack: Array<{ node: string; iter: Iterator<string> }> = [{ node: start, iter: index.imports[start]?.[Symbol.iterator]() ?? [][Symbol.iterator]() }];
    color.set(start, 1);
    path.push(start);
    pathIndex.set(start, 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const next = frame.iter.next();
      if (next.done) {
        color.set(frame.node, 2);
        stack.pop();
        pathIndex.delete(frame.node);
        path.pop();
        continue;
      }
      const target = next.value;
      const targetColor = color.get(target);
      if (targetColor === 1) {
        // Back edge: every node from the target's position down the current
        // path participates in the cycle.
        const from = pathIndex.get(target) ?? 0;
        for (const node of path.slice(from)) cyclic.add(node);
      } else if (targetColor === undefined && index.languages[target] !== undefined) {
        color.set(target, 1);
        path.push(target);
        pathIndex.set(target, path.length - 1);
        stack.push({ node: target, iter: index.imports[target]?.[Symbol.iterator]() ?? [][Symbol.iterator]() });
      }
    }
  };

  for (const file of index.files) {
    if (!color.has(file)) visit(file);
  }
  return [...cyclic].sort();
}
