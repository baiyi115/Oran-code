import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { childHostCommand } from "../utils/child-host.js";
import { runSearch, type SearchOutcome, type SearchRequest } from "./search-scan.js";

/**
 * Runs a search in the search host, with a deadline the scan itself cannot
 * enforce.
 *
 * The scan checks its budget between lines, so it cannot interrupt one line that
 * backtracks catastrophically — and the scan is synchronous, so nothing else in
 * the process runs either. Reproduced: `(a+)+b` against thirty identical
 * characters froze the agent indefinitely. The host is a separate process, so the
 * deadline here is a kill, after which whatever hits were streamed back are
 * returned with an `interrupted` flag the tool reports.
 */

export interface SearchRun extends SearchOutcome {
  /** The host was killed at the deadline: the pattern may backtrack catastrophically. */
  interrupted: boolean;
}

/** How long past the scan's own budget the host is given before it is killed. */
const HARD_TIMEOUT_SLACK_MS = 1_500;
const IDLE_KILL_MS = 60_000;

interface PendingSearch {
  hits: string[];
  settle: (run: SearchRun) => void;
  timer: NodeJS.Timeout;
}

interface SearchHost {
  child: ChildProcess;
  pending: Map<number, PendingSearch>;
  nextId: number;
  buffer: string;
  idleTimer: NodeJS.Timeout | undefined;
  dead: boolean;
}

let host: SearchHost | undefined;
let spawnUnavailable = false;

function hostCommand(): { command: string; args: string[] } {
  return childHostCommand(dirname(fileURLToPath(import.meta.url)), "search-host");
}

/** Release the event-loop ref: an idle host must not keep the CLI alive. */
function settleHost(entry: SearchHost): void {
  entry.child.unref();
  for (const stream of [entry.child.stdin, entry.child.stdout, entry.child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
  scheduleIdleKill(entry);
}

function scheduleIdleKill(entry: SearchHost): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.dead = true;
    if (host === entry) host = undefined;
    entry.child.kill();
  }, IDLE_KILL_MS);
  entry.idleTimer.unref?.();
}

/** Drop the host (and its process) so the next search starts a fresh one. */
function retireHost(entry: SearchHost): void {
  entry.dead = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (host === entry) host = undefined;
  entry.child.kill();
}

function finishPending(entry: SearchHost, id: number, run: SearchRun): void {
  const pending = entry.pending.get(id);
  if (!pending) return;
  entry.pending.delete(id);
  clearTimeout(pending.timer);
  pending.settle(run);
  if (entry.pending.size === 0 && !entry.dead) settleHost(entry);
}

function obtainHost(): SearchHost | undefined {
  if (host && !host.dead) return host;
  const { command, args } = hostCommand();
  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    spawnUnavailable = true;
    return undefined;
  }
  const entry: SearchHost = { child, pending: new Map(), nextId: 1, buffer: "", idleTimer: undefined, dead: false };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    entry.buffer += chunk;
    for (;;) {
      const newline = entry.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = entry.buffer.slice(0, newline);
      entry.buffer = entry.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id: number; ok?: boolean; event?: string; hit?: string; result?: SearchOutcome; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = entry.pending.get(message.id);
      if (!pending) continue;
      if (message.event === "hit" && typeof message.hit === "string") {
        pending.hits.push(message.hit);
        continue;
      }
      if (message.ok === true && message.result) {
        finishPending(entry, message.id, {
          hits: pending.hits,
          total: message.result.total,
          unreadable: message.result.unreadable,
          timedOut: message.result.timedOut,
          interrupted: false,
        });
        continue;
      }
      // The host answered with an error: report it as an interrupted search rather
      // than silently returning nothing.
      finishPending(entry, message.id, {
        hits: pending.hits,
        total: pending.hits.length,
        unreadable: [],
        timedOut: false,
        interrupted: true,
      });
    }
  });
  child.stderr?.on("data", () => undefined); // keep the pipe drained
  // Writing to a host that was just retired (or died) raises EPIPE on stdin; an
  // unhandled error event there would take the whole CLI down.
  child.stdin?.on("error", () => undefined);
  const failAll = (): void => {
    entry.dead = true;
    if (host === entry) host = undefined;
    for (const [id, pending] of entry.pending) {
      clearTimeout(pending.timer);
      pending.settle({
        hits: pending.hits,
        total: pending.hits.length,
        unreadable: [],
        timedOut: false,
        interrupted: true,
      });
      entry.pending.delete(id);
    }
  };
  child.on("error", failAll);
  child.on("exit", () => {
    if (!entry.dead) failAll();
  });
  settleHost(entry);
  host = entry;
  return entry;
}

/**
 * Search `request`, in the host when one can be started and in this thread
 * otherwise. The in-thread path is the fallback of last resort: it is what the
 * host exists to avoid, so it is only taken when no child process can be spawned.
 */
export async function searchWithDeadline(request: SearchRequest): Promise<SearchRun> {
  const entry = spawnUnavailable ? undefined : obtainHost();
  if (!entry || entry.dead || !entry.child.stdin?.writable) {
    const outcome = await runSearch(request);
    return { ...outcome, interrupted: false };
  }

  const id = entry.nextId++;
  scheduleIdleKill(entry);
  entry.child.ref();
  (entry.child.stdin as { ref?: () => void } | null)?.ref?.();

  return new Promise<SearchRun>((resolve) => {
    const timer = setTimeout(() => {
      // The deadline is the whole point: kill the process and keep what it sent.
      const pending = entry.pending.get(id);
      const hits = pending?.hits ?? [];
      retireHost(entry);
      entry.pending.delete(id);
      clearTimeout(timer);
      resolve({ hits, total: hits.length, unreadable: [], timedOut: true, interrupted: true });
    }, request.budgetMs + HARD_TIMEOUT_SLACK_MS);
    timer.unref?.();
    entry.pending.set(id, { hits: [], settle: resolve, timer });
    entry.child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
  });
}
