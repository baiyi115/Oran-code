import type { CheckKind, CheckStatus, EvidenceRecord } from "../evidence/types.js";

export interface AcceptanceItem {
  id: string;
  title: string;
  required: boolean;
  kind: CheckKind | "manual";
  command?: string;
  cwd?: string;
  scope?: string;
  requireContinuousSource?: boolean;
}

export interface AcceptanceSelection {
  schemaVersion: 1;
  sourcePath: string;
  digest: string;
  confirmedAt: string;
  confirmedBy: "explicit_cli_selection";
  items: AcceptanceItem[];
}

export interface ReviewSelection {
  sourcePath: string;
  digest: string;
  configDigest: string;
  sourceDigest: string;
  reviews: Array<{
    itemId: string;
    decision: "passed" | "failed";
    reviewer: string;
    reviewerKind: "human" | "ai-assisted";
    reviewedAt: string;
  }>;
}

export interface AcceptanceOptions {
  enabled: boolean;
  selection?: AcceptanceSelection;
  review?: ReviewSelection;
}

export interface ItemVerdict {
  id: string;
  title: string;
  required: boolean;
  kind: AcceptanceItem["kind"];
  command?: string;
  cwd?: string;
  scope?: string;
  status: CheckStatus | "pending_review";
  reason: string;
  evidenceId?: string;
}

export interface AcceptanceReport {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  revision: number;
  generatedAt: string;
  executionState: string;
  acceptanceStatus: "passed" | "failed" | "pending_review" | "unverified";
  configDigest?: string;
  configSource?: string;
  confirmation?: { method: string; confirmedAt: string };
  sourceDigest: string;
  sourceComplete: boolean;
  items: ItemVerdict[];
  evidence: EvidenceRecord[];
  modifications: { paths: string[]; complete: boolean; diffRef: string | null };
  limitations: string[];
}

export interface AcceptanceReportSummary {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  revision: number;
  status: AcceptanceReport["acceptanceStatus"] | "unavailable";
  reportPath?: string;
  message: string;
}
