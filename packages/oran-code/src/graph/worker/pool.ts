import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryMatchData } from "../extract-raw.js";

/**
 * One lazy child process per grammar. web-tree-sitter grammars sharing one
 * wasm instance corrupt each other, and the tsx loader does not propagate to
 * worker threads — a child process can carry it, so the host speaks NDJSON
 * over stdio and owns a private wasm instance.
 */

const IDLE_KILL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface GrammarHost {
  child: ChildProcess;
  pending: Map<number, PendingRequest>;
  nextId: number;
  idleTimer: NodeJS.Timeout | undefined;
  dead: boolean;
}

const hosts = new Map<string, GrammarHost>();
let spawnUnavailable = false;

function hostCommand(): { command: string; args: string[] } {
  const dir = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(dir, "parse-host.js");
  if (existsSync(distEntry)) return { command: process.execPath, args: [distEntry] };
  return { command: process.execPath, args: ["--import", "tsx", join(dir, "parse-host.ts")] };
}

/** Release the event-loop ref: an idle host must not keep the CLI alive. */
function settle(key: string, entry: GrammarHost): void {
  entry.child.unref();
  for (const stream of [entry.child.stdin, entry.child.stdout, entry.child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
  scheduleIdleKill(key, entry);
}

function scheduleIdleKill(key: string, entry: GrammarHost): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.dead = true;
    hosts.delete(key);
    entry.child.kill();
  }, IDLE_KILL_MS);
  entry.idleTimer.unref?.();
}

function obtain(key: string): GrammarHost | undefined {
  const existing = hosts.get(key);
  if (existing && !existing.dead) return existing;
  const { command, args } = hostCommand();
  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    spawnUnavailable = true;
    return undefined;
  }
  const entry: GrammarHost = { child, pending: new Map(), nextId: 1, idleTimer: undefined, dead: false };
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = entry.pending.get(message.id);
      if (!pending) continue;
      entry.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (entry.pending.size === 0) settle(key, entry);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "parse host error"));
    }
  });
  child.stderr?.on("data", () => undefined); // keep the pipe drained
  const failAll = (error: Error): void => {
    entry.dead = true;
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    entry.pending.clear();
    if (hosts.get(key) === entry) hosts.delete(key);
  };
  child.on("error", failAll);
  child.on("exit", (code) => {
    if (!entry.dead) failAll(new Error(`parse host exited unexpectedly (code ${code})`));
  });
  // The host is unref'd while idle (see settle()) so it never keeps the CLI
  // process alive; each request refs it again until its response arrives.
  entry.child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
  hosts.set(key, entry);
  return entry;
}

function request<T>(
  key: string,
  payload: Record<string, unknown>,
  inThread?: () => Promise<T>,
): Promise<T> {
  const entry = obtain(key);
  if (!entry || entry.dead || !entry.child.stdin?.writable) {
    return inThread ? inThread() : Promise.reject(new Error("parse host unavailable"));
  }
  scheduleIdleKill(key, entry);
  // Ref the host for the duration of the request so the event loop waits.
  entry.child.ref();
  (entry.child.stdin as { ref?: () => void } | null)?.ref?.();
  const id = entry.nextId++;
  const finish = (): void => {
    if (entry.pending.size === 0) settle(key, entry);
  };
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      finish();
      const error = new Error(`parse host timed out (${key})`);
      if (inThread) inThread().then(resolve, reject);
      else reject(error);
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    entry.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject: (error: Error) => {
        if (inThread && /unavailable|timed out|exited/.test(error.message)) inThread().then(resolve, reject);
        else reject(error);
      },
      timer,
    });
    entry.child.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

/** Specifiers for one language, parsed in an isolated host process. */
export function requestSpecifiers(languageId: string, source: string): Promise<string[]> {
  const inThread = spawnUnavailable
    ? () => import("../extract-raw.js").then((m) => m.extractSpecifiersRawFor(languageId, source))
    : undefined;
  return request<string[]>(languageId, { op: "specifiers", languageId, source }, inThread);
}

/** Raw query matches for one grammar, parsed in an isolated host process. */
export function requestQuery(grammar: string, query: string, source: string): Promise<QueryMatchData[]> {
  const inThread = spawnUnavailable
    ? () => import("../extract-raw.js").then((m) => m.runQueryRaw(grammar, query, source))
    : undefined;
  return request<QueryMatchData[]>(grammar, { op: "query", grammar, query, source }, inThread);
}
