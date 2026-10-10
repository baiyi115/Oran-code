import { createInterface } from "node:readline";
import { registerAllLanguages } from "../languages/all.js";
import { extractSpecifiersRawFor, runQueryRaw } from "../extract-raw.js";

/**
 * Long-lived parse host: one private web-tree-sitter wasm instance, NDJSON
 * requests over stdin, NDJSON responses over stdout (see pool.ts).
 */

registerAllLanguages();

interface HostRequest {
  id: number;
  op: "specifiers" | "query";
  languageId?: string;
  grammar?: string;
  query?: string;
  source: string;
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
      const result =
        request.op === "specifiers"
          ? await extractSpecifiersRawFor(request.languageId ?? "", request.source)
          : await runQueryRaw(request.grammar ?? "", request.query ?? "", request.source);
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
