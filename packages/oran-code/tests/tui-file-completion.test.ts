import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceFileIndex } from "../src/tui/composer/file-completion.js";
import { fileQuery } from "../src/tui/render.js";

describe("WorkspaceFileIndex caching and staleness", () => {
  it("reuses the built index within the TTL and rescans after it expires", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-file-completion-"));
    try {
      await writeFile(join(workspace, "first.txt"), "one", "utf8");
      const index = new WorkspaceFileIndex(workspace, { staleAfterMs: 20 });
      expect(await index.search("first")).toContain("first.txt");

      // TTL 内:新建文件不会出现——这正是"缓存要过期"存在的意义。
      await writeFile(join(workspace, "second.txt"), "two", "utf8");
      expect(await index.search("second")).not.toContain("second.txt");

      // 兴趣过后重新扫描,新文件出现。
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await index.search("second")).toContain("second.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("fileQuery", () => {
  it("parses unquoted @-fragments", () => {
    expect(fileQuery("read @src/ind", 13)).toMatchObject({ query: "src/ind", quoted: false });
  });

  it("parses quoted @-fragments with spaces in them", () => {
    const value = 'open @"dev 文档/头像';
    expect(fileQuery(value, value.length)).toMatchObject({ query: "dev 文档/头像", quoted: true });
  });

  it("returns undefined when there is no @ trigger", () => {
    expect(fileQuery("plain text", 10)).toBeUndefined();
  });
});
