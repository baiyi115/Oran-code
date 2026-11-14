import { resolve } from "node:path";
import { checkEvidence } from "../evidence/reducer.js";
import type { EvidenceRecord, SourceFingerprint } from "../evidence/types.js";
import type { AcceptanceOptions, AcceptanceReport, ItemVerdict } from "./types.js";

export function evaluateAcceptance(
  options: AcceptanceOptions,
  records: EvidenceRecord[],
  current: SourceFingerprint,
  executionState: string,
  configurationCurrent: boolean,
  persistenceAvailable = true,
): Pick<AcceptanceReport, "items" | "acceptanceStatus"> {
  const selection = options.selection;
  if (!selection) return { items: [], acceptanceStatus: "unverified" };
  const items: ItemVerdict[] = selection.items.map((item) => {
    const base = {
      id: item.id,
      title: item.title,
      required: item.required,
      kind: item.kind,
      ...(item.command ? { command: item.command } : {}),
      ...(item.cwd ? { cwd: item.cwd } : {}),
      ...(item.scope ? { scope: item.scope } : {}),
    };
    if (!persistenceAvailable) return { ...base, status: "unknown", reason: "证据账本持久化不可用" };
    if (!configurationCurrent) return { ...base, status: "stale", reason: "所选配置或复核记录已变化，需重新选择确认" };
    if (item.kind === "manual") {
      const reviews = options.review;
      const review = reviews?.reviews.find((candidate) => candidate.itemId === item.id);
      if (item.requireContinuousSource === true)
        return { ...base, status: "unknown", reason: "首版仅采样源码，无法证明全过程未变化" };
      if (
        !current.complete ||
        !review ||
        reviews?.configDigest !== selection.digest ||
        reviews.sourceDigest !== current.digest
      ) {
        return { ...base, status: "pending_review", reason: "缺少绑定当前源码与配置的显式复核记录" };
      }
      if (review.reviewerKind !== "human") {
        return { ...base, status: "pending_review", reason: `AI 辅助审阅：${review.reviewer}；仍需人工确认` };
      }
      return { ...base, status: review.decision, reason: `人工复核：${review.reviewer}，${review.reviewedAt}` };
    }
    const cwd = resolve(item.cwd!);
    const record = [...records]
      .reverse()
      .find((candidate) => candidate.command === item.command && samePath(candidate.cwd, cwd));
    if (!record) return { ...base, status: "not_run", reason: "本次尝试未执行所选命令及工作目录" };
    const status = checkEvidence(record, item.kind, item.requireContinuousSource === true);
    return {
      ...base,
      status,
      evidenceId: record.evidenceId,
      reason:
        status === "passed"
          ? `命令在声明范围内通过；${item.scope}`
          : status === "stale"
            ? "检查后源码已变化"
            : status === "blocked"
              ? "命令被权限门禁拒绝，未执行"
              : status === "failed"
                ? "进程失败、被取消或测试计数不满足要求"
                : "执行未结束、证据不完整或无法证明所要求的一致性",
    };
  });
  const required = items.filter((item) => item.required);
  const acceptanceStatus = required.some((item) => item.status === "failed")
    ? "failed"
    : executionState !== "completed" ||
        !current.complete ||
        required.length === 0 ||
        required.some((item) => ["not_run", "stale", "unknown", "blocked"].includes(item.status))
      ? "unverified"
      : required.some((item) => item.status === "pending_review")
        ? "pending_review"
        : "passed";
  return { items, acceptanceStatus };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === right.toLowerCase() : resolve(left) === right;
}
