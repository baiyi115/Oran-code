import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { childHostCommand } from "../../utils/child-host.js";
import type { FileAnalysis } from "../extract-raw.js";

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

/**
 * Grammars that a host reported as unusable after a first parse (runtime
 * .parseSource). For those, every request gets its own process: the next request
 * would otherwise be answered by a host whose grammar is already broken.
 */
const freshProcessLanguages = new Set<string>();

/** Drop a host (and its process) so the next request spawns a fresh one. */
function retire(key: string, entry: GrammarHost): void {
  entry.dead = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (hosts.get(key) === entry) hosts.delete(key);
  // Requests still queued on this host have to be told: the exit handler skips
  // failAll for a retired host, so without this they would wait for the timeout.
  for (const pending of entry.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`parse host retired (${key})`));
  }
  entry.pending.clear();
  entry.child.kill();
}

function hostCommand(): { command: string; args: string[] } {
  return childHostCommand(dirname(fileURLToPath(import.meta.url)), "parse-host");
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
      let message: { id: number; ok: boolean; result?: unknown; error?: string; retry?: boolean };
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
      if (message.retry === true) {
        // This grammar is no longer trustworthy in this process (see runtime.parseSource): kill the
        // host so the parent spawns a new one, and remember that from now on every request for this
        // grammar gets a fresh process — otherwise each request would waste a parse before
        // discovering the grammar is broken.
        freshProcessLanguages.add(key);
        retire(key, entry);
        pending.reject(new Error(message.error ?? "parse host needs a fresh process"));
        continue;
      }
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "parse host error"));
      // A grammar already known to parse only once: swap in a new process once this request is served.
      if (freshProcessLanguages.has(key) && entry.pending.size === 0) retire(key, entry);
    }
  });
  child.stderr?.on("data", () => undefined); // keep the pipe drained
  // Writing to a host that was just retired (or died) raises EPIPE on stdin; an
  // unhandled error event there would take the whole CLI down.
  child.stdin?.on("error", () => undefined);
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

function request<T>(key: string, payload: Record<string, unknown>, inThread?: () => Promise<T>): Promise<T> {
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

/** Per-language queue tail, used to serialize requests to a one-shot grammar. */
const serialTails = new Map<string, Promise<unknown>>();

/** Run these one at a time: a one-shot grammar needs its own host per request. */
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const tail = serialTails.get(key) ?? Promise.resolve();
  const next = tail.then(run, run);
  serialTails.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** One file analyzed in the host that owns its grammar: one parse, all queries. */
export function requestFileAnalysis(
  languageId: string,
  source: string,
  queries: Record<string, string> = {},
): Promise<FileAnalysis> {
  const inThread = spawnUnavailable
    ? () => import("../extract-raw.js").then((m) => m.analyzeFileRaw({ languageId, source, queries }))
    : undefined;
  const payload = { op: "analyze", languageId, source, queries };
  const attempt = (): Promise<FileAnalysis> => request<FileAnalysis>(languageId, payload, inThread);
  const run = async (): Promise<FileAnalysis> => {
    if (freshProcessLanguages.has(languageId)) return serialized(languageId, attempt);
    try {
      return await attempt();
    } catch (error) {
      // The request may have been the one that discovered the grammar is
      // one-shot; wait for that to settle, then take the serialized path so a
      // burst of files cannot fight over a host that only survives one request.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (freshProcessLanguages.has(languageId)) return serialized(languageId, attempt);
      throw error;
    }
  };
  return run();
}
