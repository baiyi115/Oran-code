import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Task, TaskState } from "./types.js";

// Load the Node built-in at runtime so Vite/Vitest does not try to bundle it.
// `node:sqlite` is available in the supported Node 22.5+ runtime.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface TraceExport {
  task: Task;
  steps: Array<Record<string, unknown>>;
  toolCalls: Array<Record<string, unknown>>;
  fileChanges: Array<Record<string, unknown>>;
}

export interface TraceStore {
  saveTask(task: Task): void;
  getTask(taskId: string): Task | undefined;
  listTasks(limit?: number): Task[];
  appendStep(taskId: string, kind: string, payload: unknown): number;
  appendToolCall(taskId: string, name: string, argumentsValue: Record<string, unknown>, result: string | null, ok: boolean, durationMs: number, stepId?: number): void;
  appendFileChange(taskId: string, path: string, beforeHash: string | null, afterHash: string | null): void;
  exportTrace(taskId: string): TraceExport;
  close(): void;
}

export class InMemoryTraceStore implements TraceStore {
  private readonly tasks = new Map<string, Task>();
  private readonly steps: Array<Record<string, unknown>> = [];
  private readonly toolCalls: Array<Record<string, unknown>> = [];
  private readonly fileChanges: Array<Record<string, unknown>> = [];

  saveTask(task: Task): void {
    this.tasks.set(task.id, { ...task });
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  listTasks(limit = 50): Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((task) => ({ ...task }));
  }

  appendStep(taskId: string, kind: string, payload: unknown): number {
    const stepIndex = this.steps.filter((step) => step.taskId === taskId).length;
    this.steps.push({ id: this.steps.length + 1, taskId, stepIndex, kind, payload: JSON.stringify(payload), createdAt: new Date().toISOString() });
    return this.steps.length;
  }

  appendToolCall(taskId: string, name: string, argumentsValue: Record<string, unknown>, result: string | null, ok: boolean, durationMs: number, stepId?: number): void {
    this.toolCalls.push({ id: this.toolCalls.length + 1, taskId, ...(stepId !== undefined ? { stepId } : {}), name, arguments: JSON.stringify(argumentsValue), result, ok: ok ? 1 : 0, durationMs, createdAt: new Date().toISOString() });
  }

  appendFileChange(taskId: string, path: string, beforeHash: string | null, afterHash: string | null): void {
    this.fileChanges.push({ id: this.fileChanges.length + 1, taskId, path, beforeHash, afterHash, createdAt: new Date().toISOString() });
  }

  exportTrace(taskId: string): TraceExport {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    return {
      task,
      steps: this.steps.filter((step) => step.taskId === taskId).map((step) => ({ ...step })),
      toolCalls: this.toolCalls.filter((call) => call.taskId === taskId).map((call) => ({ ...call })),
      fileChanges: this.fileChanges.filter((change) => change.taskId === taskId).map((change) => ({ ...change })),
    };
  }

  close(): void {}
}

export class SqliteTraceStore implements TraceStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly workspace: string | undefined;

  constructor(path: string, workspace?: string) {
    this.workspace = workspace;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        plan TEXT,
        model TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_id INTEGER REFERENCES task_steps(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        result TEXT,
        ok INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  static async open(path: string, workspace?: string): Promise<SqliteTraceStore> {
    await mkdir(dirname(path), { recursive: true });
    return new SqliteTraceStore(path, workspace);
  }

  saveTask(task: Task): void {
    if (this.workspace && task.workspace !== this.workspace) {
      throw new Error(`trace workspace mismatch: expected ${this.workspace}, received ${task.workspace}`);
    }
    this.db.prepare(`
      INSERT INTO tasks (id, workspace, prompt, state, plan, model, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, plan = excluded.plan,
        model = excluded.model, result = excluded.result, updated_at = excluded.updated_at
    `).run(task.id, task.workspace, task.prompt, task.state, task.plan ?? null, task.model ?? null, task.result ?? null, task.createdAt, task.updatedAt);
  }

  getTask(taskId: string): Task | undefined {
    const row = this.workspace
      ? this.db.prepare("SELECT * FROM tasks WHERE id = ? AND workspace = ?").get(taskId, this.workspace)
      : this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return row ? taskFromRow(row) : undefined;
  }

  listTasks(limit = 50): Task[] {
    const rows = this.workspace
      ? this.db.prepare("SELECT * FROM tasks WHERE workspace = ? ORDER BY created_at DESC LIMIT ?").all(this.workspace, limit)
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map(taskFromRow);
  }

  appendStep(taskId: string, kind: string, payload: unknown): number {
    const result = this.db.prepare(`
      INSERT INTO task_steps (task_id, step_index, kind, payload, created_at)
      VALUES (?, (SELECT COALESCE(MAX(step_index), -1) + 1 FROM task_steps WHERE task_id = ?), ?, ?, ?)
    `).run(taskId, taskId, kind, JSON.stringify(payload), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  appendToolCall(taskId: string, name: string, argumentsValue: Record<string, unknown>, result: string | null, ok: boolean, durationMs: number, stepId?: number): void {
    this.db.prepare(`
      INSERT INTO tool_calls (task_id, step_id, name, arguments, result, ok, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, stepId ?? null, name, JSON.stringify(argumentsValue), result, ok ? 1 : 0, durationMs, new Date().toISOString());
  }

  appendFileChange(taskId: string, path: string, beforeHash: string | null, afterHash: string | null): void {
    this.db.prepare(`
      INSERT INTO file_changes (task_id, path, before_hash, after_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, path, beforeHash, afterHash, new Date().toISOString());
  }

  exportTrace(taskId: string): TraceExport {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    return {
      task,
      steps: this.db.prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index").all(taskId),
      toolCalls: this.db.prepare("SELECT * FROM tool_calls WHERE task_id = ? ORDER BY id").all(taskId),
      fileChanges: this.db.prepare("SELECT * FROM file_changes WHERE task_id = ? ORDER BY id").all(taskId),
    };
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function taskFromRow(row: Record<string, unknown>): Task {
  const task: Task = {
    id: String(row.id),
    workspace: String(row.workspace),
    prompt: String(row.prompt),
    state: String(row.state) as TaskState,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (typeof row.plan === "string") task.plan = row.plan;
  if (typeof row.model === "string") task.model = row.model;
  if (typeof row.result === "string") task.result = row.result;
  return task;
}
