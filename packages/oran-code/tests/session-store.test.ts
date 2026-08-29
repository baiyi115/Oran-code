import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateSessionId,
  parseSessionJsonl,
  rebuildConversation,
  SessionStore,
  type SessionJsonlRecord,
  type StoredSession,
} from "../src/session-store.js";
import type { Message } from "../src/types.js";

describe("SessionStore JSONL archives", () => {
  let originalUserDataDir: string | undefined;
  let testUserDataDir: string | undefined;

  beforeEach(async () => {
    originalUserDataDir = process.env.ORAN_USER_DATA_DIR;
    testUserDataDir = await mkdtemp(join(tmpdir(), "oran-test-userdata-"));
    process.env.ORAN_USER_DATA_DIR = testUserDataDir;
  });

  afterEach(async () => {
    if (originalUserDataDir !== undefined) process.env.ORAN_USER_DATA_DIR = originalUserDataDir;
    else delete process.env.ORAN_USER_DATA_DIR;
    if (testUserDataDir) await rm(testUserDataDir, { recursive: true, force: true });
  });

  it("appends state and new messages, then restores the same session", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-"));
    try {
      const store = new SessionStore(root);
      await store.open();
      const first: Message[] = [{ role: "user", content: "hello" }];
      const created = await store.create("  Saved  ", {
        workMode: "plan",
        reasoningEffort: "high",
        modelReference: { provider: "demo", model: "chat" },
        conversation: first,
      });
      const conversation: Message[] = [...first, { role: "assistant", content: "hi" }];
      const updated = await store.update(created.id, { history: ["hello"], messages: [], conversation });

      expect(updated).toMatchObject({
        name: "Saved",
        workMode: "plan",
        reasoningEffort: "high",
        modelReference: { provider: "demo", model: "chat" },
        history: ["hello"],
        conversation,
      });
      const archive = join(store.directory, `${created.id}.jsonl`);
      const records = parseSessionJsonl(await readFile(archive, "utf8"));
      expect(records.filter((record) => record.type === "message")).toHaveLength(2);
      expect(records.filter((record) => record.type === "state")).toHaveLength(2);

      const reopened = new SessionStore(root);
      await reopened.open();
      expect(await reopened.ensureConversation(created.id)).toMatchObject({ conversation, reasoningEffort: "high" });
      expect(await reopened.remove(created.id)).toBe(true);
      expect(reopened.list()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips bad and empty lines and uses the last reset boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-bad-lines-"));
    try {
      const store = new SessionStore(root);
      await store.open();
      const created = await store.create("recover", { conversation: [{ role: "user", content: "old" }] });
      const replacement: Message[] = [
        { role: "user", content: "summary-backed prompt" },
        { role: "assistant", content: "replacement" },
      ];
      await store.update(created.id, { conversation: replacement });
      const archive = join(store.directory, `${created.id}.jsonl`);
      await appendFile(
        archive,
        [
          "{broken-json",
          "",
          JSON.stringify({ role: "user", content: "", timestamp: new Date().toISOString() }),
          JSON.stringify({ role: "user", content: "after-boundary", timestamp: new Date().toISOString() }),
          "",
        ].join("\n"),
        "utf8",
      );

      const reopened = new SessionStore(root);
      await reopened.open();
      expect((await reopened.ensureConversation(created.id))?.conversation).toEqual([
        ...replacement,
        { role: "user", content: "after-boundary" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds summary boundaries and truncates an unmatched tool chain", () => {
    const timestamp = new Date().toISOString();
    const records: SessionJsonlRecord[] = [
      { type: "message", timestamp, role: "user", content: "discarded" },
      {
        type: "compaction-boundary",
        role: "system",
        timestamp,
        content: { summary: "earlier work", retainedTail: [{ role: "assistant", content: "recent" }] },
      },
      { type: "message", timestamp, role: "user", content: "continue" },
      {
        type: "message",
        timestamp,
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: {}, createdAt: timestamp }],
      },
    ];
    const rebuilt = rebuildConversation(records);
    expect(rebuilt).toHaveLength(3);
    expect(rebuilt[0]?.content).toContain("earlier work");
    expect(rebuilt[1]).toMatchObject({ role: "assistant", content: "recent" });
    expect(rebuilt[2]).toMatchObject({ role: "user", content: "continue" });
  });

  it("derives list metadata and restores a legacy JSONL archive without state records", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-legacy-jsonl-"));
    try {
      const directory = join(root, ".oran", "sessions");
      await mkdir(directory, { recursive: true });
      const id = "legacy-lines-only";
      const timestamp = new Date().toISOString();
      const archive = join(directory, `${id}.jsonl`);
      await writeFile(
        archive,
        [
          JSON.stringify({ role: "user", content: "first legacy prompt", timestamp }),
          JSON.stringify({ role: "assistant", content: "legacy answer", timestamp }),
          JSON.stringify({ type: "compaction-boundary", role: "system", timestamp, content: { retainedTail: [null] } }),
        ].join("\n"),
        "utf8",
      );

      const store = new SessionStore(root);
      await store.open();
      const restored = store.find(id);
      expect(restored).toMatchObject({
        id,
        name: "Current session",
        archiveMessageCount: 2,
        archiveTitle: "first legacy prompt",
        conversation: [
          { role: "user", content: "first legacy prompt" },
          { role: "assistant", content: "legacy answer" },
        ],
      });
      expect(restored?.archiveSize).toBe((await stat(join(store.directory, `${id}.jsonl`))).size);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes compacted conversations as summary and role-content tail boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-summary-boundary-"));
    try {
      const store = new SessionStore(root);
      await store.open();
      const created = await store.create("compact", { conversation: [{ role: "user", content: "old prompt" }] });
      await store.update(created.id, {
        conversation: [
          {
            role: "system",
            content: "<context-summary>\nfinished setup\n</context-summary>",
            metadata: { promptBlock: "context-summary", contextManaged: true },
          },
          {
            role: "system",
            content: "recovery instructions",
            metadata: { promptBlock: "context-recovery", contextManaged: true },
          },
          { role: "user", content: "continue here", metadata: { ignored: true } },
          { role: "assistant", content: "ready", name: "assistant-name" },
        ],
      });

      const records = parseSessionJsonl(await readFile(join(store.directory, `${created.id}.jsonl`), "utf8"));
      const boundary = records.find((record) => record.type === "compaction-boundary");
      expect(boundary).toMatchObject({
        type: "compaction-boundary",
        content: {
          summary: "finished setup",
          retainedTail: [
            { role: "user", content: "continue here" },
            { role: "assistant", content: "ready" },
          ],
        },
      });
      expect(boundary && boundary.type === "compaction-boundary" ? boundary.content.reset : undefined).toBeUndefined();

      const reopened = new SessionStore(root);
      await reopened.open();
      expect((await reopened.ensureConversation(created.id))?.conversation).toEqual([
        expect.objectContaining({ role: "user", content: expect.stringContaining("finished setup") }),
        { role: "user", content: "continue here" },
        { role: "assistant", content: "ready" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates the legacy aggregate once and preserves its id", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-migrate-"));
    try {
      const legacyPath = join(root, ".oran", "sessions.json");
      await mkdir(join(root, ".oran"), { recursive: true });
      const now = new Date().toISOString();
      const legacy: StoredSession = {
        id: "session-legacy",
        name: "Legacy",
        workspace: root,
        createdAt: now,
        updatedAt: now,
        messages: [],
        history: [],
        conversation: [{ role: "user", content: "from old store" }],
      };
      await writeFile(legacyPath, `${JSON.stringify([legacy])}\n`, "utf8");

      const store = new SessionStore(root);
      await store.open();
      expect((await store.ensureConversation(legacy.id))?.conversation).toEqual(legacy.conversation);
      expect(await stat(`${legacyPath}.migrated`)).toBeDefined();

      const reopened = new SessionStore(root);
      await reopened.open();
      expect(reopened.list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects legacy transcript snapshots with a non-string abort message", async () => {
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-invalid-abort-"));
    try {
      const legacyPath = join(root, ".oran", "sessions.json");
      await mkdir(join(root, ".oran"), { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        legacyPath,
        `${JSON.stringify([
          {
            id: "session-invalid-abort",
            name: "Invalid abort",
            workspace: root,
            createdAt: now,
            updatedAt: now,
            messages: [{ id: "assistant-1", kind: "assistant", text: "partial", abortMessage: 42 }],
            history: [],
          },
        ])}\n`,
        "utf8",
      );

      const store = new SessionStore(root);
      await store.open();

      expect(store.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates sortable ids and removes only expired archives", async () => {
    expect(generateSessionId(1_000)).toMatch(/^rs-[0-9a-f]{6}$/);
    expect(generateSessionId(1_000).localeCompare(generateSessionId(1_001))).toBeLessThan(0);
    const root = await mkdtemp(join(tmpdir(), "liteagent-store-clean-"));
    try {
      const store = new SessionStore(root);
      await store.open();
      const old = await store.create("old");
      const fresh = await store.create("fresh");
      const oldPath = join(store.directory, `${old.id}.jsonl`);
      const oldDate = new Date(Date.now() - 31 * 86_400_000);
      await utimes(oldPath, oldDate, oldDate);

      expect(await store.cleanExpired()).toBe(1);
      expect(store.find(old.id)).toBeUndefined();
      expect(store.find(fresh.id)).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
