export const EVIDENCE_SCHEMA_VERSION = 1;

export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "blocked";
export type CheckStatus = "passed" | "failed" | "not_run" | "stale" | "unknown" | "blocked";
export type CheckKind = "test" | "typecheck" | "build" | "command";

export interface TestSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
  cancelled?: number;
  total?: number;
}

export interface SourceFingerprint {
  policyVersion: 1;
  digest: string;
  complete: boolean;
  fileCount: number;
  capturedAt: string;
  scope: string;
  limitations: string[];
}

export interface EvidenceRecord {
  schemaVersion: 1;
  evidenceId: string;
  taskId: string;
  attemptId: string;
  executionId: string;
  callId?: string;
  commandSig: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  executionStatus: ExecutionStatus;
  exitCode: number | null;
  signal: string | null;
  waitTimedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
  parserKind: string;
  summary: TestSummary;
  diagnosticSummary?: TestSummary;
  logRef?: string;
  outputCompleteness: "complete" | "truncated" | "missing";
  sourceFingerprint: { start: SourceFingerprint; end?: SourceFingerprint };
  scope: string;
  freshness: "current" | "stale" | "unknown";
  environment: string;
  limitations: string[];
}

export interface CommandObservation {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  spawnError?: string;
  outputTruncated?: boolean;
  cancelled?: boolean;
}

export interface CommandEvidenceHandle {
  readonly executionId: string;
  receipt(): EvidenceRecord;
  markWaitTimedOut(): Promise<void>;
  complete(outcome: CommandObservation): Promise<void>;
}

/** Only the trusted executor supplies this port; model arguments cannot create it. */
export interface CommandEvidencePort {
  begin(command: string, cwd: string, callId?: string): Promise<CommandEvidenceHandle>;
  blocked?(command: string, cwd: string, callId?: string): Promise<void>;
}

export interface EvidenceLedger {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  workspace: string;
  updatedAt: string;
  records: EvidenceRecord[];
  limitations: string[];
}
