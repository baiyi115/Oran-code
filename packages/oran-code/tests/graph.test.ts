import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, fingerprintSources, scanSources } from "../src/graph/index.js";
import { ensureGraph } from "../src/graph/store.js";
import { dependents } from "../src/graph/query.js";
import type { GraphIndex } from "../src/graph/languages/registry.js";

let workspace = "";

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(workspace, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "oran-graph-"));
  await write(
    "pkg/a.ts",
    [
      'import { helper, Base } from "./b";',
      'export * from "./c";',
      'const mod = require("./d");',
      '// import "./fake";',
      'const s = "import \\"./also-fake\\"";',
      "export const a = helper();",
      "export class Child extends Base {}",
    ].join("\n"),
  );
  await write(
    "pkg/b.ts",
    'import { leaf } from "./c";\nexport function helper() { return leaf; }\nexport function runner() { helper(); }\nexport class Base {}',
  );
  await write("pkg/c.ts", 'import "./a";\nexport const leaf = 1;');
  await write("pkg/d.ts", "export const d = 2;");
  await write("src_py/__init__.py", "");
  await write(
    "src_py/m.py",
    [
      "import helpers.util",
      "from . import sibling",
      "from ..outside import nope",
      "from helpers.util import calculate",
      "def run():",
      "    calculate()",
    ].join("\n"),
  );
  await write("helpers/__init__.py", "");
  await write("helpers/util.py", "import os\n\ndef calculate():\n    return 1\n");
  await write("src_py/sibling.py", "x = 1\n");
  await write("go.mod", "module example.com/m\n\ngo 1.22\n");
  await write(
    "main.go",
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/m/util"\n)\n\nfunc main() { fmt.Println(util.X) }\n',
  );
  await write("util/util.go", "package util\n\nvar X = 1\n");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("code impact graph", () => {
  let index: GraphIndex;

  it("builds an index over all three languages with correct edges", async () => {
    const scanned = await scanSources(workspace);
    index = await buildGraph(workspace, scanned);

    expect(index.files).toContain("pkg/a.ts");
    expect(index.languages["pkg/a.ts"]).toBe("typescript");
    expect(index.languages["src_py/m.py"]).toBe("python");
    expect(index.languages["main.go"]).toBe("go");

    // a.ts -> b, c (export *), d (require); c -> a forms a cycle; no fake entries.
    expect(index.imports["pkg/a.ts"]).toEqual(["pkg/b.ts", "pkg/c.ts", "pkg/d.ts"]);
    expect(index.imports["pkg/b.ts"]).toEqual(["pkg/c.ts"]);
    expect(index.imports["pkg/c.ts"]).toEqual(["pkg/a.ts"]);

    // Python: absolute via ancestor walk; bare-dot relative -> package __init__.
    expect(index.imports["src_py/m.py"]).toContain("helpers/util.py");
    expect(index.imports["src_py/m.py"]).toContain("src_py/__init__.py");
    // from ..outside import nope: repo has no such module, and it is not an installed package.
    expect(index.unresolved["src_py/m.py"]).toContainEqual({ specifier: "..outside", reason: "no-source" });
    // import os resolves nowhere in-repo and stays external (by design).
    expect(index.unresolved["helpers/util.py"]).toContainEqual({ specifier: "os", reason: "external" });

    // Go: module path mapping lands on the package directory.
    expect(index.imports["main.go"]).toEqual(["util/util.go"]);
    expect(index.unresolved["main.go"]).toContainEqual({ specifier: "fmt", reason: "external" });

    // Comments and strings never produce specifiers.
    expect(JSON.stringify(index)).not.toContain("fake");
  });

  it("extracts L2 symbols with statically determined call and inheritance edges", () => {
    expect(index.symbols?.find((symbol) => symbol.id === "pkg/b.ts#helper")).toMatchObject({
      kind: "function",
      file: "pkg/b.ts",
    });
    expect(index.symbols?.find((symbol) => symbol.id === "pkg/a.ts#Child")).toMatchObject({ kind: "class" });
    // Same-file call edge.
    expect(index.calls).toContainEqual({ from: "pkg/b.ts#runner", to: "pkg/b.ts#helper", provenance: "resolved" });
    // Cross-file call edge via a from-import binding.
    expect(index.calls).toContainEqual({
      from: "src_py/m.py#run",
      to: "helpers/util.py#calculate",
      provenance: "resolved",
    });
    // Inheritance edge across files.
    expect(index.extendsEdges).toContainEqual({ from: "pkg/a.ts#Child", to: "pkg/b.ts#Base" });
  });

  it("computes dependents with cycle-safe BFS", () => {
    const impacted = dependents(index, "pkg/c.ts", 3);
    // a and b both depend on c; the a<->c cycle must not explode the traversal.
    const paths = impacted.map((file) => file.path);
    expect(paths).toContain("pkg/a.ts");
    expect(paths).toContain("pkg/b.ts");
    expect(impacted.find((file) => file.path === "pkg/b.ts")?.distance).toBe(1);
    expect(impacted.find((file) => file.path === "pkg/a.ts")?.distance).toBe(1);
  });

  it("caches by fingerprint, rebuilds on mtime change, heals after deletion", async () => {
    const first = await ensureGraph(workspace);
    expect(first.cached).toBe(false);

    const second = await ensureGraph(workspace);
    expect(second.cached).toBe(true);

    // Touch any indexed file: the next call must rebuild, incrementally.
    await utimes(join(workspace, "pkg/a.ts"), new Date(), new Date(Date.now() + 2000));
    const third = await ensureGraph(workspace);
    expect(third.cached).toBe(false);
    expect(third.incremental).toBe(true);
    // Incremental rebuild preserves untouched files' edges.
    expect(third.index.imports["pkg/b.ts"]).toEqual(["pkg/c.ts"]);
    expect(third.index.calls?.some((edge) => edge.from === "pkg/b.ts#runner")).toBe(true);

    // Deleting the cache file heals silently on the next call.
    const { rm: remove } = await import("node:fs/promises");
    const { graphIndexPath } = await import("../src/graph/store.js");
    await remove(graphIndexPath(workspace));
    const fourth = await ensureGraph(workspace);
    expect(fourth.cached).toBe(false);
    expect(fourth.index.files.length).toBe(third.index.files.length);
  });

  it("produces a stable short fingerprint over path + mtime", async () => {
    const scanned = await scanSources(workspace);
    expect(fingerprintSources(scanned)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintSources(scanned)).toBe(fingerprintSources([...scanned]));
  });
});
