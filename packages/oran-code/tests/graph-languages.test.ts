import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, scanSources } from "../src/graph/index.js";
import type { GraphIndex } from "../src/graph/languages/registry.js";

let workspace = "";

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(workspace, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

function reasonsOf(index: GraphIndex, file: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of index.unresolved[file] ?? []) map.set(entry.specifier, entry.reason);
  return map;
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "oran-graph-langs-"));

  await write("src/lib.rs", "mod foo;\nuse crate::foo::bar;\nuse serde::things;\n\nfn main() { bar(); }\n");
  await write("src/foo.rs", "pub fn bar() {}\n");

  await write("main.c", '#include "util.h"\n#include <stdio.h>\nint main(void) { return 0; }\n');
  await write("util.h", "#pragma once\n");
  await write("main.cpp", '#include "types.hpp"\nint main() { return 0; }\n');
  await write("types.hpp", "#pragma once\n");

  await write("src/com/a/Main.java", "package com.a;\nimport com.b.Util;\nimport com.b.*;\nclass Main {}\n");
  await write("src/com/b/Util.java", "package com.b;\nclass Util {}\n");

  await write("single/M.cs", "namespace M { class Only {} }\n");
  await write("single/UsesM.cs", "using M;\nclass UsesM {}\n");
  await write("multi/A.cs", "namespace N { class A {} }\n");
  await write("multi/B.cs", "namespace N { class B {} }\n");
  await write("multi/UsesN.cs", "using N;\nclass UsesN {}\n");

  await write("kt/Main.kt", "package p\nimport q.Util\n");
  await write("kt/Util.kt", "package q\nclass Util\n");
  await write("sc/Main.scala", "package sp\nimport sq.Util\n");
  await write("sc/Util.scala", "package sq\nclass Util\n");

  await write("composer.json", '{"autoload": {"psr-4": {"App\\\\": "src/App"}}}');
  await write("index.php", '<?php\nuse App\\Foo;\nrequire __DIR__ . "/helper.php";\ninclude "vendor_lib.php";\n');
  await write("src/App/Foo.php", "<?php\n");
  await write("helper.php", "<?php\n");

  await write("main.rb", 'require_relative "helper"\nrequire "missing_lib"\n');
  await write("helper.rb", "# helper\n");

  await write("MyMod/inner.swift", "let x = 1\n");
  await write("main.swift", "import MyMod\nimport Foundation\n");

  await write("main.lua", 'local m = require("util.sub")\n');
  await write("util/sub.lua", "return {}\n");

  await write("main.sh", 'source ./lib.sh\nsource "$DIR/other.sh"\n');
  await write("lib.sh", "# lib\n");

  await write("pubspec.yaml", "name: myapp\n");
  await write("main.dart", "import 'package:myapp/util.dart';\nimport 'rel.dart';\nimport 'dart:io';\n");
  await write("lib/util.dart", "// dart\n");
  await write("rel.dart", "// rel\n");

  await write("comp.vue", '<script setup lang="ts">\nimport X from "./x.ts"\n// import "./fake.ts"\n</script>\n<template><div>{{ X }}</div></template>\n');
  await write("x.ts", "export const X = 1;\n");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("per-language resolution", () => {
  let index: GraphIndex;

  beforeAll(async () => {
    index = await buildGraph(workspace, await scanSources(workspace));
  });

  it("rust: mod + crate:: resolve, inline mod does not, bare crates stay external", () => {
    expect(index.imports["src/lib.rs"]).toEqual(["src/foo.rs"]);
    expect(reasonsOf(index, "src/lib.rs").get("use:serde::things")).toBe("external");
  });

  it("c/cpp: quoted includes resolve, system includes stay external", () => {
    expect(index.imports["main.c"]).toEqual(["util.h"]);
    expect(reasonsOf(index, "main.c").get("<stdio.h>")).toBe("external");
    expect(index.imports["main.cpp"]).toEqual(["types.hpp"]);
  });

  it("java: class import resolves by package index, wildcard spans the package", () => {
    expect(index.imports["src/com/a/Main.java"]).toContain("src/com/b/Util.java");
    // Wildcard and class import both reach Util.java; both edges deduplicate.
    expect(index.imports["src/com/a/Main.java"]).toEqual(["src/com/b/Util.java"]);
  });

  it("c#: single declaring file resolves, a namespace spread over files is ambiguous", () => {
    expect(index.imports["single/UsesM.cs"]).toEqual(["single/M.cs"]);
    expect(reasonsOf(index, "multi/UsesN.cs").get("n:N")).toBe("ambiguous");
  });

  it("kotlin and scala resolve through package headers", () => {
    expect(index.imports["kt/Main.kt"]).toEqual(["kt/Util.kt"]);
    expect(index.imports["sc/Main.scala"]).toEqual(["sc/Util.scala"]);
  });

  it("php: psr-4 use and __DIR__ require resolve, bare include falls back, vendor needs config", () => {
    expect(index.imports["index.php"]).toContain("src/App/Foo.php");
    expect(index.imports["index.php"]).toContain("helper.php");
    expect(reasonsOf(index, "index.php").get("r:include \"vendor_lib.php\"")).toBe("needs-config");
  });

  it("ruby: require_relative is exact, unknown gems stay external", () => {
    expect(index.imports["main.rb"]).toEqual(["helper.rb"]);
    expect(reasonsOf(index, "main.rb").get("missing_lib")).toBe("external");
  });

  it("swift: a same-named source directory resolves, frameworks stay external", () => {
    expect(index.imports["main.swift"]).toEqual(["MyMod/inner.swift"]);
    expect(reasonsOf(index, "main.swift").get("Foundation")).toBe("external");
  });

  it("lua: dotted module names map to files", () => {
    expect(index.imports["main.lua"]).toEqual(["util/sub.lua"]);
  });

  it("bash: literal source paths resolve, expansions stay dynamic", () => {
    expect(index.imports["main.sh"]).toEqual(["lib.sh"]);
    const reasons = [...(index.unresolved["main.sh"] ?? []).values()];
    expect(reasons).toContainEqual({ specifier: "$DIR/other.sh", reason: "dynamic" });
  });

  it("dart: own package URIs and relative imports resolve, dart: stays external", () => {
    expect(index.imports["main.dart"]).toEqual(["lib/util.dart", "rel.dart"]);
    expect(reasonsOf(index, "main.dart").get("dart:io")).toBe("external");
  });

  it("vue: script-block imports resolve through the TS grammar, comments do not", () => {
    expect(index.imports["comp.vue"]).toEqual(["x.ts"]);
    expect(JSON.stringify(index)).not.toContain("fake.ts");
  });
});
