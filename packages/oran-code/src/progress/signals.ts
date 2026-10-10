/**
 * Judgment layer output is a list of signals, not a stop decision: most
 * signals are only recorded or injected, and only `hard` signals may enter
 * the gate layer and pause the task. New criteria default to info/warn.
 */

import type { TurnSnapshot } from "./capture.js";
import type { PhaseState } from "./phase.js";

export type ProgressSignalKind =
  | "phase_egress"
  | "implement_budget"
  | "explore_budget"
  | "low_symbol_novelty"
  | "rehearsal_diverged"
  | "same_error"
  | "goal_drift"
  | "test_regression"
  | "test_count_drop"
  | "state_loop"
  | "readonly_repeat"
  | "write_repeat"
  | "cost_without_progress";

/** info is log-only; warn is injected into context; hard is the only level allowed to pause. */
export type ProgressSeverity = "info" | "warn" | "hard";

export interface ProgressSignal {
  kind: ProgressSignalKind;
  severity: ProgressSeverity;
  detail: string;
  sinceTurn: number;
}

export interface SignalWindowInput {
  /** Snapshot window including the current turn, chronological. */
  snapshots: readonly TurnSnapshot[];
  phase: PhaseState;
  allowedPaths: readonly string[];
  budgets: { exploreBudget: number; implementBudget: number };
}

const GOAL_DRIFT_WARN_TURNS = 2;

/**
 * Level-based signals computed over the snapshot window. These fire while the
 * condition holds (they are idempotent per turn), unlike event signals from
 * the phase machine which fire only on transitions. Repeated identical errors
 * are deliberately absent: the loop's repeated_error guard already covers it.
 */
export function computeSignals(input: SignalWindowInput): ProgressSignal[] {
  const signals: ProgressSignal[] = [];
  const { snapshots, phase, budgets } = input;
  const current = snapshots.at(-1);
  if (!current) return signals;

  if (phase.phase === "implement" && phase.implementTurns > budgets.implementBudget) {
    signals.push({
      kind: "implement_budget",
      severity: "hard",
      detail: `${phase.implementTurns} implement turns (budget ${budgets.implementBudget})`,
      sinceTurn: current.turn,
    });
  }

  // Test evidence comparisons: current turn's evidence vs the most recent
  // earlier value in the window. Missing evidence on either side means no verdict.
  const evidenceOf = (snapshot: TurnSnapshot | undefined) =>
    snapshot?.evidence?.testsPassed !== undefined || snapshot?.evidence?.testsTotal !== undefined
      ? snapshot.evidence
      : undefined;
  const currentEvidence = evidenceOf(current);
  if (currentEvidence) {
    const previousEvidence = [...snapshots.slice(0, -1)]
      .reverse()
      .map((snapshot) => evidenceOf(snapshot))
      .find((evidence) => evidence !== undefined);
    if (previousEvidence) {
      // Counts are only comparable when both came from the same test command: a
      // subset run (one file, one test name) reports fewer passed tests than a
      // full run and would otherwise hard-pause the task mid-debugging.
      const sameCommand =
        currentEvidence.commandSig !== undefined && currentEvidence.commandSig === previousEvidence.commandSig;
      if (
        sameCommand &&
        currentEvidence.testsPassed !== undefined &&
        previousEvidence.testsPassed !== undefined &&
        currentEvidence.testsPassed < previousEvidence.testsPassed
      ) {
        signals.push({
          kind: "test_regression",
          severity: "hard",
          detail: `tests passed dropped ${previousEvidence.testsPassed} -> ${currentEvidence.testsPassed}`,
          sinceTurn: current.turn,
        });
      }
      if (
        sameCommand &&
        currentEvidence.testsTotal !== undefined &&
        previousEvidence.testsTotal !== undefined &&
        currentEvidence.testsTotal < previousEvidence.testsTotal
      ) {
        signals.push({
          kind: "test_count_drop",
          severity: "hard",
          detail: `total tests dropped ${previousEvidence.testsTotal} -> ${currentEvidence.testsTotal}`,
          sinceTurn: current.turn,
        });
      }
    }
  }

  // State loop: the files this task has written hold the same bytes as they did
  // at an earlier turn, with mutations in between — work that undid itself. The
  // digest is content-based; while it mixed in mtimes it could never repeat an
  // earlier value, which made this check unreachable.
  const currentDigest = current.workspaceDigest;
  const loopIndex = currentDigest
    ? snapshots.findIndex(
        (snapshot, index) =>
          index < snapshots.length - 1 &&
          snapshot.workspaceDigest === currentDigest &&
          snapshots.slice(index + 1, -1).some((s) => s.toolCalls.some((call) => call.mutated)),
      )
    : -1;
  if (loopIndex >= 0) {
    signals.push({
      kind: "state_loop",
      severity: "warn",
      detail: `workspace returned to the state of turn ${snapshots[loopIndex]?.turn}`,
      sinceTurn: current.turn,
    });
  }

  // Goal drift: trailing consecutive turns whose real writes land outside the
  // set this task has already written to.
  //
  // Deliberately warn-only. The anchor cannot tell "authorized new file" from
  // "wandering off": a four-file refactor, or TDD starting from the test file,
  // writes nothing but never-before-touched files for four turns in a row, and
  // a gate that stops work on that guess is worse than a reminder. The plan
  // document reaches the same conclusion in §6.4 (goal drift starts as
  // reflection); the hard tier that contradicted it is removed here.
  if (input.allowedPaths.length > 0) {
    const allowed = new Set(input.allowedPaths);
    let driftRun = 0;
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (!snapshot) break;
      const outOfScope = snapshot.toolCalls.some(
        (call) => call.mutated && call.paths.some((path) => !allowed.has(path)),
      );
      if (!outOfScope) break;
      driftRun += 1;
    }
    if (driftRun >= GOAL_DRIFT_WARN_TURNS) {
      const outside = [
        ...new Set(
          snapshots
            .slice(-driftRun)
            .flatMap((snapshot) => snapshot.toolCalls.flatMap((call) => (call.mutated ? call.paths : []))),
        ),
      ].sort();
      signals.push({
        kind: "goal_drift",
        severity: "warn",
        detail:
          `${driftRun} consecutive turns wrote only files this task had not touched yet` +
          (outside.length ? ` (${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""})` : ""),
        sinceTurn: current.turn,
      });
    }
  }

  return signals;
}

/** Rendered as a reminder for the model; internal severity levels stay internal. */
export function signalToNotice(signal: ProgressSignal): string {
  switch (signal.kind) {
    case "phase_egress":
      return (
        "Heads up: the task has fallen back from making changes to pure reading " +
        `${signal.detail}. If the current direction is stalled, reconsider the approach instead of drifting back to exploration.`
      );
    case "explore_budget":
      return (
        "Heads up: exploration has covered a lot of files. " +
        "Summarize what you have learned and commit to a concrete next action (or state the blocker) before reading further."
      );
    case "low_symbol_novelty":
      return (
        "Heads up: the last several turns of reading produced almost no new information " +
        `(${signal.detail}). Stop reading broadly; commit to a hypothesis and verify it directly.`
      );
    case "rehearsal_diverged":
      return `Progress gate: ${signal.detail}`;
    case "goal_drift":
      return (
        "Heads up: recent turns wrote nothing but files this task had not touched yet " +
        `(${signal.detail}). If that is intentional, carry on; if not, restate the scope before writing more.`
      );
    case "state_loop":
      return `Heads up: ${signal.detail} — your recent changes cancel out. Decide what the file should contain instead of editing it back and forth.`;
    default:
      return `Heads up: ${signal.kind} — ${signal.detail}`;
  }
}
