import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryExtractor, parseExtractedMemories } from "../src/memory-extractor.js";
import { MemoryManager } from "../src/memory-manager.js";
import type { Message, ModelProvider, ModelResponse, ModelStreamChunk } from "../src/types.js";

class ResponseProvider implements ModelProvider {
  readonly requests: Message[][] = [];
  constructor(private readonly respond: (messages: Message[], call: number) => string | Promise<string>) {}

  async complete(messages: Message[]): Promise<ModelResponse> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const text = await this.respond(messages, this.requests.length);
    return { text, toolCalls: [], raw: {}, usage: {}, streamed: false };
  }

  async *streamResponse(): AsyncGenerator<ModelStreamChunk> {
    throw new Error("streamResponse should not be used by memory services");
  }
}

describe("MemoryManager", () => {
  let originalUserDataDir: string | undefined;
  let testUserDataDir: string | undefined;

  beforeEach(async () => {
    originalUserDataDir = process.env.ORAN_USER_DATA_DIR;
    testUserDataDir = await mkdtemp(join(tmpdir(), "oran-test-memory-userdata-"));
    process.env.ORAN_USER_DATA_DIR = testUserDataDir;
  });

  afterEach(async () => {
    if (originalUserDataDir !== undefined) process.env.ORAN_USER_DATA_DIR = originalUserDataDir;
    else delete process.env.ORAN_USER_DATA_DIR;
    if (testUserDataDir) await rm(testUserDataDir, { recursive: true, force: true });
  });

  it("routes notes, supports legacy metadata, and builds bounded summary and index shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-memory-"));
    const workspace = join(root, "workspace");
    const userDirectory = join(root, "user-memory");
    await mkdir(workspace, { recursive: true });
    const manager = new MemoryManager(workspace, { userDirectory });
    try {
      const project = await manager.writeNote({
        id: "project-conventions",
        type: "project-knowledge",
        description: "Use TypeScript for maintained code.",
        body: "The maintained implementation language is TypeScript.",
        fileName: "../../Project Conventions.md",
      });
      const preference = await manager.writeNote({
        id: "concise-output",
        type: "user-preference",
        description: "Prefer concise status updates.",
        body: "Keep progress messages compact.",
      });
      await writeFile(join(userDirectory, "legacy.md"), [
        "---",
        "id: legacy-correction",
        "description: Keep the existing public API.",
        "metadata:",
        "  type: correction-feedback",
        "---",
        "Do not rename public commands without migration support.",
        "",
      ].join("\n"), "utf8");

      expect(project?.scope).toBe("project");
      expect(project?.path).toMatch(/Project-Conventions\.md$/u);
      expect(preference?.scope).toBe("user");
      const notes = await manager.scan();
      expect(notes.map((note) => [note.id, note.type, note.scope])).toEqual(expect.arrayContaining([
        ["project-conventions", "project-knowledge", "project"],
        ["concise-output", "user-preference", "user"],
        ["legacy-correction", "correction-feedback", "user"],
      ]));

      const index = await manager.rebuildIndex();
      const savedIndex = await readFile(manager.indexPath, "utf8");
      expect(savedIndex.trim()).toBe(index);
      expect(index).toContain("project-conventions | ~/.oran/memory/");
      expect(index).toContain("Project-Conventions.md");
      expect(index).toContain("concise-output | ~/.oran/memory/concise-output.md");
      expect(index).not.toContain("Keep progress messages compact");

      const summary = await manager.buildSummary();
      expect(summary).toContain("project-conventions | project-knowledge | Use TypeScript for maintained code.");
      expect(summary).not.toContain(".oran/memory");
      expect(summary).not.toContain("The maintained implementation language");
      expect(summary.split("\n").length).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(25 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects only valid non-injected memories and isolates selector failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-memory-select-"));
    const manager = new MemoryManager(root, { userDirectory: join(root, "user") });
    try {
      await manager.writeNote({ id: "alpha", type: "project-knowledge", description: "Alpha architecture", body: "Alpha body" });
      await manager.writeNote({ id: "beta", type: "user-preference", description: "Beta preference", body: "Beta body" });
      const provider = new ResponseProvider(() => "```json\n{\"ids\":[\"alpha\",\"beta\",\"missing\"]}\n```");
      const selected = await manager.findRelevant("architecture", provider, { injectedIds: ["beta"], maxResults: 2 });
      expect(selected.map((note) => note.id)).toEqual(["alpha"]);
      expect(provider.requests[0]?.[1]?.content).not.toContain("id: beta");

      const failing = new ResponseProvider(() => { throw new Error("selector unavailable"); });
      await expect(manager.findRelevant("architecture", failing)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MemoryExtractor", () => {
  let originalUserDataDir: string | undefined;
  let testUserDataDir: string | undefined;

  beforeEach(async () => {
    originalUserDataDir = process.env.ORAN_USER_DATA_DIR;
    testUserDataDir = await mkdtemp(join(tmpdir(), "oran-test-extractor-userdata-"));
    process.env.ORAN_USER_DATA_DIR = testUserDataDir;
  });

  afterEach(async () => {
    if (originalUserDataDir !== undefined) process.env.ORAN_USER_DATA_DIR = originalUserDataDir;
    else delete process.env.ORAN_USER_DATA_DIR;
    if (testUserDataDir) await rm(testUserDataDir, { recursive: true, force: true });
  });

  it("parses fixed blocks and merges concurrent requests into one latest tail run", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-memory-extract-"));
    const manager = new MemoryManager(root, { userDirectory: join(root, "user") });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const provider = new ResponseProvider(async (messages, call) => {
      if (call === 1) await firstGate;
      const snapshot = messages[1]?.content ?? "";
      if (call === 1) return "ID: first-note\nTYPE: project-knowledge\nDESCRIPTION: First\nBODY:\nFirst body";
      expect(snapshot).toContain("latest snapshot");
      expect(snapshot).not.toContain("superseded snapshot");
      return "ID: latest-note\nTYPE: 用户偏好\nDESCRIPTION: Latest\nFILENAME: latest choice.md\nBODY:\nLatest body";
    });
    const extractor = new MemoryExtractor({ manager, provider, minSnapshotLength: 1 });
    try {
      const first = extractor.extract("initial snapshot with durable project knowledge");
      await Promise.resolve();
      await expect(extractor.extract("superseded snapshot")).resolves.toEqual([]);
      await expect(extractor.extract("latest snapshot")).resolves.toEqual([]);
      releaseFirst?.();
      expect((await first).map((note) => note.id)).toEqual(["first-note"]);
      await extractor.waitForIdle();
      expect(provider.requests).toHaveLength(2);
      expect((await manager.scan()).map((note) => note.id)).toEqual(expect.arrayContaining(["first-note", "latest-note"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops placeholders and malformed blocks", () => {
    expect(parseExtractedMemories("NOTHING_TO_RECORD")).toEqual([]);
    expect(parseExtractedMemories([
      "ID: valid",
      "TYPE: reference-material",
      "DESCRIPTION: Useful reference",
      "BODY:",
      "Reference body",
      "---",
      "TYPE: project-knowledge",
      "BODY:",
      "Missing id",
    ].join("\n"))).toEqual([
      { id: "valid", type: "reference-material", description: "Useful reference", body: "Reference body" },
    ]);
  });
});
