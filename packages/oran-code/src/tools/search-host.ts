import { createInterface } from "node:readline";
import { runSearch, type SearchRequest } from "./search-scan.js";

/**
 * Search host: the process that runs a search.
 *
 * It exists so the search can be killed. A model-supplied regular expression can
 * backtrack catastrophically on a short input (`(a+)+b` against thirty identical
 * characters never returns), and the scan is synchronous, so a budget checked
 * between lines cannot interrupt it — in the agent's own process that froze the
 * TUI and the task (reproduced). Here the parent kills this process instead, and
 * keeps the hits that were streamed before it died.
 *
 * NDJSON over stdio, one request at a time per line; see search-service.ts.
 */

interface HostRequest extends SearchRequest {
  id: number;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request: HostRequest;
  try {
    request = JSON.parse(line) as HostRequest;
  } catch {
    return;
  }
  void (async () => {
    try {
      const outcome = await runSearch(request, (hit) => {
        process.stdout.write(`${JSON.stringify({ id: request.id, event: "hit", hit })}\n`);
      });
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: outcome })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  })();
});
// stdin end (parent died or closed the pipe) drains the loop once the in-flight
// search returns, or never — the parent kills this process when it must.
