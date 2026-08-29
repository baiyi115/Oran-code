import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTraceStore, SqliteTraceStore, type TraceStore } from "../src/trace.js";
import type { Task } from "../src/types.js";

const roots: string[] = [];
const openStores: TraceStore[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oran-trace-"));
  roots.push(root);
  return root;
}

/** SQLite rows use snake_case columns; the in-memory store uses camelCase. */
function pick(row: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!row) return undefined;
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed stores are fine; cleanup must not mask test failures.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function task(workspace: string, id = "task-1", createdAt = "2026-08-28T00:00:00.000Z"): Task {
  return {
    id,
    workspace,
    prompt: "fix the bug",
    state: "executing",
    createdAt,
    updatedAt: createdAt,
  };
}

function sharedStoreContract(name: string, makeStore: () => TraceStore | Promise<TraceStore>): void {
  describe(name, () => {
    it("persists, updates and lists tasks", async () => {
      const store = makeStore();
      const resolved = store instanceof Promise ? await store : store;
      openStores.push(resolved);
      const first = task("ws-a", "task-1", "2026-08-28T00:00:01.000Z");
      const second = task("ws-a", "task-2", "2026-08-28T00:00:02.000Z");
      resolved.saveTask(first);
      resolved.saveTask(second);

      resolved.saveTask({ ...first, state: "completed", result: "done" });
      expect(resolved.getTask("task-1")).toMatchObject({ state: "completed", result: "done" });
      expect(resolved.getTask("missing")).toBeUndefined();

      const listed = resolved.listTasks(1);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe("task-2");
    });

    it("appends steps, tool calls and file changes for exportTrace", async () => {
      const store = makeStore();
      const resolved = store instanceof Promise ? await store : store;
      openStores.push(resolved);
      resolved.saveTask(task("ws-a", "task-1"));
      resolved.appendStep("task-1", "model_response", { text: "hello" });
      resolved.appendStep("task-1", "tool_result", { ok: true });
      resolved.appendToolCall("task-1", "read_file", { path: "a.ts" }, "content", true, 12);
      resolved.appendToolCall("task-1", "write_file", { path: "a.ts" }, null, false, 30, 2);
      resolved.appendFileChange("task-1", "a.ts", null, "abc123");

      const exported = resolved.exportTrace("task-1");
      expect(exported.task.id).toBe("task-1");
      expect(exported.steps.map((step) => step.kind)).toEqual(["model_response", "tool_result"]);
      expect(exported.toolCalls.map((entry) => entry.ok)).toEqual([1, 0]);
      expect(pick(exported.toolCalls[1], "stepId", "step_id")).toBe(2);
      expect(pick(exported.toolCalls[1], "durationMs", "duration_ms")).toBe(30);
      expect(exported.fileChanges[0]).toMatchObject({ path: "a.ts" });
      expect(pick(exported.fileChanges[0], "beforeHash", "before_hash")).toBeNull();
      expect(pick(exported.fileChanges[0], "afterHash", "after_hash")).toBe("abc123");

      expect(() => resolved.exportTrace("missing")).toThrowError(/task not found/);
    });
  });
}

sharedStoreContract("InMemoryTraceStore", () => new InMemoryTraceStore());

sharedStoreContract("SqliteTraceStore", async () => {
  const root = await makeRoot();
  return await SqliteTraceStore.open(join(root, "contract", "trace.db"));
});

describe("InMemoryTraceStore isolation", () => {
  it("returns defensive copies of tasks", () => {
    const store = new InMemoryTraceStore();
    openStores.push(store);
    store.saveTask(task("ws-a", "task-1"));
    const loaded = store.getTask("task-1");
    if (loaded) loaded.state = "completed";
    expect(store.getTask("task-1")?.state).toBe("executing");
  });

  it("numbers steps per task and exposes stepIndex", () => {
    const store = new InMemoryTraceStore();
    store.saveTask(task("ws-a", "task-1"));
    store.appendStep("task-1", "model_response", {});
    store.appendStep("task-1", "model_response", {});
    const exported = store.exportTrace("task-1");
    expect(exported.steps.map((step) => step.stepIndex)).toEqual([0, 1]);
  });
});

describe("SqliteTraceStore workspace scoping", () => {
  it("rejects tasks from a foreign workspace", async () => {
    const root = await makeRoot();
    const store = await SqliteTraceStore.open(join(root, "trace.db"), root);
    openStores.push(store);
    store.saveTask(task(root, "task-1"));
    expect(store.getTask("task-1")).toBeDefined();
    expect(() => store.saveTask(task(join(root, "elsewhere"), "task-2"))).toThrowError(/trace workspace mismatch/);
  });

  it("accepts execution worktrees owned by the bound workspace", async () => {
    const root = await makeRoot();
    const store = await SqliteTraceStore.open(join(root, "trace.db"), root);
    openStores.push(store);
    const worktreeWorkspace = join(root, ".oran", "worktrees", "wt-1");
    store.saveTask({ ...task(worktreeWorkspace, "task-1"), rootWorkspace: root });
    expect(store.getTask("task-1")).toBeDefined();
  });

  it("hides tasks whose root workspace differs from the bound workspace", async () => {
    const root = await makeRoot();
    const dbPath = join(root, "shared.db");
    const writer = await SqliteTraceStore.open(dbPath);
    writer.saveTask({ ...task(root, "task-1"), rootWorkspace: root });
    writer.saveTask({ ...task(join(root, "elsewhere"), "task-2"), rootWorkspace: join(root, "elsewhere") });
    writer.close();

    const scoped = await SqliteTraceStore.open(dbPath, root);
    openStores.push(scoped);
    expect(scoped.getTask("task-1")).toBeDefined();
    expect(scoped.getTask("task-2")).toBeUndefined();
    expect(scoped.listTasks().map((entry) => entry.id)).toEqual(["task-1"]);
  });

  it("monotonically numbers steps per task", async () => {
    const root = await makeRoot();
    const store = await SqliteTraceStore.open(join(root, "trace.db"));
    openStores.push(store);
    store.saveTask(task(root, "task-1"));
    const first = store.appendStep("task-1", "model_response", {});
    const second = store.appendStep("task-1", "model_response", {});
    store.saveTask({ ...task(root, "task-2", "2026-08-28T00:00:05.000Z"), updatedAt: "2026-08-28T00:00:05.000Z" });
    const other = store.appendStep("task-2", "model_response", {});
    expect(second).toBeGreaterThan(first);
    expect(other).toBeGreaterThan(second);
    const exported = store.exportTrace("task-1");
    expect(exported.steps.map((step) => pick(step, "stepIndex", "step_index"))).toEqual([0, 1]);
  });

  it("closing twice is safe and reopening keeps prior data", async () => {
    const root = await makeRoot();
    const path = join(root, "trace.db");
    const first = await SqliteTraceStore.open(path);
    first.saveTask(task(root, "task-1"));
    first.close();
    first.close();

    const reopened = await SqliteTraceStore.open(path);
    openStores.push(reopened);
    expect(reopened.getTask("task-1")).toMatchObject({ prompt: "fix the bug" });
  });
});
