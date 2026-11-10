import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runtime state (sessions, traces, checkpoints, snapshots, caches) lives under the user's Oran
// data directory. Give each test file its own temporary directory so a test run never reads or
// writes the developer's ~/.oran.
const root = mkdtempSync(join(tmpdir(), "oran-test-user-data-"));
process.env.ORAN_USER_DATA_DIR = root;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
