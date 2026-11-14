import { createHash, randomUUID } from "node:crypto";
import { parseTestSummary } from "./parsers.js";
import { fingerprintSource } from "./fingerprint.js";
import { evidenceFreshness } from "./reducer.js";
import { controlledPath, writeArtifact } from "./store.js";
import type {
  CommandEvidenceHandle,
  CommandEvidencePort,
  CommandObservation,
  EvidenceLedger,
  EvidenceRecord,
  SourceFingerprint,
} from "./types.js";

export class EvidenceCollector implements CommandEvidencePort {
  readonly attemptId = `attempt-${randomUUID()}`;
  readonly limitations = new Set<string>();
  get persistenceAvailable(): boolean {
    return this.limitations.size === 0;
  }
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly recordLimit = 1_000;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly completing = new Set<Promise<void>>();

  constructor(
    readonly workspace: string,
    readonly taskId: string,
  ) {}

  async begin(command: string, cwd: string, callId?: string): Promise<CommandEvidenceHandle> {
    if (command.length > 8_000) {
      this.limitations.add("command_identity_size_limit");
      throw new Error("Command exceeds the evidence identity limit");
    }
    if (this.records.size >= this.recordLimit) {
      this.limitations.add("evidence_record_limit");
      throw new Error("Evidence record limit reached");
    }
    let start: SourceFingerprint;
    try {
      start = await fingerprintSource(this.workspace);
    } catch (error) {
      this.limitations.add("source_sampling_unavailable");
      throw error;
    }
    const executionId = `exec-${randomUUID()}`;
    const record: EvidenceRecord = {
      schemaVersion: 1,
      evidenceId: executionId,
      taskId: this.taskId,
      attemptId: this.attemptId,
      executionId,
      ...(callId ? { callId } : {}),
      command,
      cwd,
      commandSig: createHash("sha256").update(command).update("\0").update(cwd).digest("hex"),
      startedAt: new Date().toISOString(),
      executionStatus: "running",
      exitCode: null,
      signal: null,
      waitTimedOut: false,
      cancelled: false,
      parserKind: "unknown",
      summary: {},
      outputCompleteness: "missing",
      sourceFingerprint: { start },
      scope: "exact_command_and_cwd;coverage_not_inferred",
      freshness: "unknown",
      environment: `node:${process.version};platform:${process.platform};arch:${process.arch}`,
      limitations: [
        "sample_only",
        "external_services_not_fingerprinted",
        "inherited_environment_not_fingerprinted",
        ...start.limitations,
      ],
    };
    this.records.set(executionId, record);
    await this.save();
    let completion: Promise<void> | undefined;
    return {
      executionId,
      receipt: () => structuredClone(record),
      markWaitTimedOut: async () => {
        record.waitTimedOut = true;
        await this.save();
      },
      complete: (outcome) => {
        if (!completion) {
          completion = this.complete(record, outcome).catch((error: unknown) => {
            this.limitations.add(
              `evidence_completion_unavailable:${error instanceof Error ? error.message : String(error)}`,
            );
          });
          this.completing.add(completion);
          void completion.finally(() => this.completing.delete(completion!));
        }
        return completion;
      },
    };
  }

  async blocked(command: string, cwd: string, callId?: string): Promise<void> {
    const handle = await this.begin(command, cwd, callId);
    const record = this.records.get(handle.executionId)!;
    record.executionStatus = "blocked";
    record.finishedAt = new Date().toISOString();
    record.limitations.push("permission_denied;command_not_executed");
    await this.save();
  }

  private async complete(record: EvidenceRecord, outcome: CommandObservation): Promise<void> {
    record.finishedAt = new Date().toISOString();
    record.exitCode = outcome.exitCode;
    record.signal = outcome.signal;
    record.cancelled = outcome.cancelled === true;
    record.executionStatus = record.cancelled
      ? "cancelled"
      : outcome.exitCode === 0 && !outcome.signal && !outcome.spawnError
        ? "completed"
        : "failed";
    if (outcome.spawnError) record.spawnError = outcome.spawnError;
    const output = `${outcome.stdout}\n${outcome.stderr}`;
    const parsed = parseTestSummary(output);
    record.parserKind = parsed.parserKind;
    record.summary = outcome.outputTruncated ? {} : parsed.summary;
    if (outcome.outputTruncated) record.diagnosticSummary = parsed.summary;
    record.outputCompleteness = outcome.outputTruncated ? "truncated" : "complete";
    record.limitations = [...new Set([...record.limitations, ...parsed.limitations])];
    record.sourceFingerprint.end = await fingerprintSource(this.workspace);
    record.freshness = evidenceFreshness(record, record.sourceFingerprint.end);
    if (record.sourceFingerprint.start.digest !== record.sourceFingerprint.end.digest)
      record.limitations.push("changed_during_execution");
    try {
      const name = `${record.executionId}.log`;
      const target = await controlledPath(this.workspace, this.taskId, this.attemptId, name);
      await writeArtifact(target, `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`);
      record.logRef = name;
    } catch {
      record.diagnosticSummary = parsed.summary;
      record.summary = {};
      record.limitations.push("log_unavailable");
      record.outputCompleteness = "missing";
    }
    await this.save();
  }

  snapshot(): EvidenceLedger {
    return {
      schemaVersion: 1,
      workspace: this.workspace,
      taskId: this.taskId,
      attemptId: this.attemptId,
      updatedAt: new Date().toISOString(),
      records: structuredClone([...this.records.values()]),
      limitations: [...this.limitations],
    };
  }

  async flush(): Promise<void> {
    // Wait only for already-exited processes; a still-running background command never blocks delivery.
    await Promise.all([...this.completing]);
    await this.save();
  }

  async finalize(): Promise<{ ledger: EvidenceLedger; current: SourceFingerprint }> {
    await this.flush();
    const current = await fingerprintSource(this.workspace);
    for (const record of this.records.values()) record.freshness = evidenceFreshness(record, current);
    await this.save();
    return { ledger: this.snapshot(), current };
  }

  private save(): Promise<void> {
    const content = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    const job = this.writeTail.then(async () => {
      const target = await controlledPath(this.workspace, this.taskId, this.attemptId, "ledger.json");
      await writeArtifact(target, content);
    });
    this.writeTail = job.catch(() => {
      this.limitations.add("ledger_persistence_unavailable");
    });
    return this.writeTail;
  }
}
