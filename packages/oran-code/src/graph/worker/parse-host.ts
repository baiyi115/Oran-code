import { createInterface } from "node:readline";
import { registerAllLanguages } from "../languages/all.js";
import { analyzeFileRaw, type FileAnalysisRequest } from "../extract-raw.js";

/**
 * Long-lived parse host: one private web-tree-sitter wasm instance, NDJSON
 * requests over stdin, NDJSON responses over stdout (see pool.ts).
 */

registerAllLanguages();

interface HostRequest {
  id: number;
  op: "analyze";
  languageId?: string;
  source: string;
  queries?: Record<string, string> | undefined;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let request: HostRequest;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  void (async () => {
    try {
      const payload: FileAnalysisRequest = {
        languageId: request.languageId ?? "",
        source: request.source,
        queries: request.queries,
      };
      const result = await analyzeFileRaw(payload);
      // Some grammars can parse only once in this process (runtime.parseSource). The result is then
      // untrustworthy: have the parent retry with another host, and this process serves no further
      // requests.
      if (result.needsFreshProcess === true) {
        process.stdout.write(
          `${JSON.stringify({ id: request.id, ok: false, retry: true, error: "grammar needs a fresh process" })}\n`,
          () => process.exit(0),
        );
        return;
      }
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  })();
});
// stdin end (parent died or closed the pipe) drains the loop naturally once
// in-flight parses settle; no explicit exit — an immediate EOF (file stdin)
// would otherwise kill pending work.
