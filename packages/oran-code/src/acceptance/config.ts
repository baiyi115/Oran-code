import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { isWithinPath, resolvePhysicalPath } from "../utils/path-containment.js";
import { resolveCommandCwd } from "../tools/process.js";
import type { AcceptanceSelection, ReviewSelection } from "./types.js";

async function readConfig(
  path: string,
): Promise<{ value: Record<string, unknown>; digest: string; sourcePath: string }> {
  const sourcePath = resolve(path);
  const file = await open(sourcePath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 128 * 1024)
      throw new Error("Acceptance configuration must be a file of at most 128 KiB");
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128 * 1024) throw new Error("Acceptance configuration is too large");
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Acceptance configuration must be an object");
    return {
      value: value as Record<string, unknown>,
      digest: createHash("sha256").update(text).digest("hex"),
      sourcePath,
    };
  } finally {
    await file.close();
  }
}

function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid acceptance ${name}`);
  return value;
}

/** Selection comes from host argv, not project discovery or a model-generated plan. */
export async function loadAcceptance(path: string, workspace: string): Promise<AcceptanceSelection> {
  const { value, digest, sourcePath } = await readConfig(path);
  if (value.schemaVersion !== 1 || !Array.isArray(value.items) || !value.items.length || value.items.length > 100)
    throw new Error("Expected acceptance schemaVersion 1 with 1–100 items");
  const ids = new Set<string>();
  const items: AcceptanceSelection["items"] = [];
  for (const raw of value.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid acceptance item");
    const item = raw as Record<string, unknown>;
    const id = text(item.id, "item id", 100);
    if (ids.has(id)) throw new Error("Duplicate acceptance item id");
    ids.add(id);
    const kind = item.kind;
    if (!["test", "typecheck", "build", "command", "manual"].includes(String(kind)))
      throw new Error("Invalid acceptance item kind");
    if (item.required !== undefined && typeof item.required !== "boolean") throw new Error("required must be boolean");
    if (item.requireContinuousSource !== undefined && typeof item.requireContinuousSource !== "boolean")
      throw new Error("requireContinuousSource must be boolean");
    items.push({
      id,
      title: text(item.title, "title"),
      kind: kind as AcceptanceSelection["items"][number]["kind"],
      required: item.required !== false,
      ...(kind !== "manual"
        ? {
            command: text(item.command, "command", 8_000),
            cwd: await resolveCommandCwd(workspace, item.cwd),
            scope: text(item.scope, "scope"),
          }
        : {}),
      ...(item.requireContinuousSource === true ? { requireContinuousSource: true } : {}),
    });
  }
  return {
    schemaVersion: 1,
    sourcePath,
    digest,
    confirmedAt: new Date().toISOString(),
    confirmedBy: "explicit_cli_selection",
    items,
  };
}

export async function loadReview(path: string, workspace: string): Promise<ReviewSelection> {
  const physicalWorkspace = await resolvePhysicalPath(workspace);
  const physicalReview = await resolvePhysicalPath(path);
  if (!physicalWorkspace || !physicalReview || isWithinPath(physicalWorkspace, physicalReview)) {
    throw new Error("Manual review records must be selected from outside the agent-editable workspace");
  }
  const { value, digest, sourcePath } = await readConfig(path);
  if (value.schemaVersion !== 1 || !Array.isArray(value.reviews) || value.reviews.length > 100)
    throw new Error("Invalid review schema");
  const ids = new Set<string>();
  const reviews: ReviewSelection["reviews"] = value.reviews.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid review entry");
    const item = raw as Record<string, unknown>;
    const itemId = text(item.itemId, "review item id", 100);
    if (ids.has(itemId)) throw new Error("Duplicate review item id");
    ids.add(itemId);
    if (item.decision !== "passed" && item.decision !== "failed") throw new Error("Invalid review decision");
    if (item.reviewerKind !== "human" && item.reviewerKind !== "ai-assisted") throw new Error("Invalid reviewer kind");
    const reviewedAt = text(item.reviewedAt, "reviewedAt", 100);
    if (!Number.isFinite(Date.parse(reviewedAt)) || Date.parse(reviewedAt) > Date.now())
      throw new Error("Invalid review timestamp");
    return {
      itemId,
      decision: item.decision,
      reviewer: text(item.reviewer, "reviewer", 200),
      reviewerKind: item.reviewerKind,
      reviewedAt,
    };
  });
  return {
    sourcePath,
    digest,
    configDigest: text(value.configDigest, "config digest", 64),
    sourceDigest: text(value.sourceDigest, "source digest", 64),
    reviews,
  };
}
