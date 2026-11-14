import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import { redactSecretText } from "../formatting.js";
import { controlledPath, writeArtifact } from "../evidence/store.js";
import type { EvidenceCollector } from "../evidence/collector.js";
import type { Task } from "../types.js";
import { evaluateAcceptance } from "./evaluate.js";
import type { AcceptanceOptions, AcceptanceReport, AcceptanceReportSummary } from "./types.js";

const execFileAsync = promisify(execFile);
const publications = new WeakMap<EvidenceCollector, Promise<AcceptanceReportSummary>>();

async function unchanged(path: string, expected: string): Promise<boolean> {
  try {
    const file = await open(path, "r");
    try {
      if ((await file.stat()).size > 128 * 1024) return false;
      const buffer = Buffer.alloc(128 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return (
        bytesRead <= 128 * 1024 && createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex") === expected
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

export function publishAcceptance(
  task: Task,
  collector: EvidenceCollector,
  options: AcceptanceOptions,
): Promise<AcceptanceReportSummary> {
  const existing = publications.get(collector);
  if (existing) return existing;
  const publication = publish(task, collector, options).catch((error: unknown): AcceptanceReportSummary => ({
    schemaVersion: 1,
    taskId: task.id,
    attemptId: collector.attemptId,
    revision: 1,
    status: "unavailable",
    message: `验收报告不可用：${redactSecretText(error instanceof Error ? error.message : String(error))}`,
  }));
  publications.set(collector, publication);
  return publication;
}

async function publish(
  task: Task,
  collector: EvidenceCollector,
  options: AcceptanceOptions,
): Promise<AcceptanceReportSummary> {
  await collector.flush();
  const modifications: AcceptanceReport["modifications"] = { paths: [], complete: false, diffRef: null };
  try {
    const status = await execFileAsync(
      "git",
      ["--no-optional-locks", "-C", task.workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const entries = status.stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      modifications.paths.push(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2))) {
        if (entries[i + 1]) modifications.paths.push(entries[++i]!);
      }
    }
    modifications.complete = true;
  } catch {
    /* Missing Git data remains explicitly unavailable. */
  }
  // Resample after ancillary collection and use the latest ledger snapshot before publication.
  const final = await collector.finalize();
  const current = final.current;
  const configCurrent =
    (!options.selection || (await unchanged(options.selection.sourcePath, options.selection.digest))) &&
    (!options.review || (await unchanged(options.review.sourcePath, options.review.digest)));
  const evaluated = evaluateAcceptance(
    options,
    final.ledger.records,
    current,
    task.state,
    configCurrent,
    collector.persistenceAvailable,
  );
  const report: AcceptanceReport = {
    schemaVersion: 1,
    taskId: task.id,
    attemptId: collector.attemptId,
    revision: 1,
    generatedAt: new Date().toISOString(),
    executionState: task.state,
    ...evaluated,
    ...(options.selection
      ? {
          configDigest: options.selection.digest,
          configSource: options.selection.sourcePath,
          confirmation: { method: options.selection.confirmedBy, confirmedAt: options.selection.confirmedAt },
        }
      : {}),
    sourceDigest: current.digest,
    sourceComplete: current.complete,
    items: evaluated.items,
    evidence: final.ledger.records,
    modifications,
    limitations: [
      ...new Set([
        ...final.ledger.limitations,
        ...current.limitations,
        "commands_collected_from_main_controller_only",
        "redaction_best_effort;preview_before_sharing",
        "modification_list_includes_preexisting_changes",
        "historical_diff_unavailable",
        "background_results_after_publication_are_ledger_only",
        ...(!configCurrent ? ["configuration_changed"] : []),
      ]),
    ],
  };
  // Export summaries, never raw command output. Redaction is best-effort and requires preview before sharing.
  const safeReport = sanitize(report) as AcceptanceReport;
  const jsonPath = await controlledPath(task.workspace, task.id, collector.attemptId, "report.json");
  const markdownPath = await controlledPath(task.workspace, task.id, collector.attemptId, "report.md");
  await writeArtifact(markdownPath, renderReport(safeReport));
  await writeArtifact(jsonPath, `${JSON.stringify(safeReport, null, 2)}\n`);
  const summary: AcceptanceReportSummary = {
    schemaVersion: 1,
    taskId: task.id,
    attemptId: collector.attemptId,
    revision: 1,
    status: report.acceptanceStatus,
    reportPath: jsonPath,
    message: `需求验收：${report.acceptanceStatus}；报告：${jsonPath}`,
  };
  // The manifest is published last so consumers can distinguish a complete bundle.
  await writeArtifact(
    await controlledPath(task.workspace, task.id, collector.attemptId, "publication.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactSecretText(stripVTControlCharacters(value));
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  return value;
}

function escape(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/([\\`*_[\]<>|])/g, "\\$1")
    .replace(/[\r\n]+/g, " ");
}

function renderReport(report: AcceptanceReport): string {
  const rows = report.items.map(
    (item) =>
      `| ${escape(item.id)} | ${escape(item.title)} | ${item.required ? "必选" : "可选"} | ${item.status} | ${escape(item.reason)} |`,
  );
  return [
    "# 任务交付验收报告",
    "",
    `执行状态：${report.executionState}；需求验收：${report.acceptanceStatus}`,
    "",
    `任务：${report.taskId}；尝试：${report.attemptId}；报告版本：${report.schemaVersion}/${report.revision}`,
    `源码摘要：${report.sourceDigest}；覆盖完整：${report.sourceComplete}`,
    "",
    "| 验收项 | 标题 | 要求 | 状态 | 依据 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## 检查证据",
    "",
    ...report.evidence.map(
      (record) =>
        `- ${record.evidenceId}：${escape(record.command)}；进程 ${record.executionStatus}；退出码 ${record.exitCode ?? "unknown"}；新鲜度 ${record.freshness}；日志 ${record.outputCompleteness}`,
    ),
    "",
    "## 工作区变更路径",
    "",
    "以下包含任务开始前已有改动；未保存历史 diff。",
    ...report.modifications.paths.map((path) => `- ${escape(path)}`),
    "",
    "## 限制与未完成项",
    "",
    ...report.limitations.map((limitation) => `- ${escape(limitation)}`),
    "",
    "报告未复制原始输出；脱敏不保证无敏感信息，分享前需人工预览。",
    "",
  ].join("\n");
}
