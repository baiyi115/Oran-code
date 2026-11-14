import type { CheckKind, CheckStatus, EvidenceRecord, SourceFingerprint } from "./types.js";

export function evidenceFreshness(record: EvidenceRecord, current: SourceFingerprint): EvidenceRecord["freshness"] {
  const { start, end } = record.sourceFingerprint;
  if (!start.complete || !end?.complete || !current.complete) return "unknown";
  if (start.digest !== end.digest) return "unknown";
  return end.digest === current.digest ? "current" : "stale";
}

export function checkEvidence(record: EvidenceRecord, kind: CheckKind, requireContinuous = false): CheckStatus {
  if (record.executionStatus === "blocked") return "blocked";
  if (record.freshness === "stale") return "stale";
  if (record.executionStatus === "running") return "unknown";
  if (
    record.executionStatus === "cancelled" ||
    record.executionStatus === "failed" ||
    record.exitCode !== 0 ||
    record.signal ||
    record.spawnError
  )
    return "failed";
  if ((record.summary.failed ?? record.diagnosticSummary?.failed ?? 0) > 0) return "failed";
  if (record.freshness !== "current" || (requireContinuous && record.limitations.includes("sample_only")))
    return "unknown";
  if (kind !== "test") return "passed";
  if (record.outputCompleteness !== "complete") return "unknown";
  if (record.parserKind === "unknown") return "unknown";
  const { passed, failed, cancelled, total, skipped } = record.summary;
  if (record.parserKind === "text-summary") return "unknown";
  if ((cancelled ?? 0) > 0 || passed === 0 || total === 0 || (total !== undefined && skipped === total))
    return "failed";
  if (passed === undefined || passed <= 0) return "unknown";
  // Reporter counts assist the successful process exit, never replace it.
  if (failed !== undefined && failed > 0) return "failed";
  if (total !== undefined && passed + (failed ?? 0) + (skipped ?? 0) + (cancelled ?? 0) > total) return "unknown";
  return "passed";
}
