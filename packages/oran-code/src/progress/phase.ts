import type { TurnSnapshot } from "./capture.js";
import type { ProgressSignal } from "./signals.js";

/**
 * Explore/implement phasing. Legal long tasks read many files inside the
 * explore budget without ever hitting a threshold; falling back from making
 * changes to pure reading is the strong signal that catches "keeps reading
 * different files forever" — it judges phase flow, not request repetition.
 */

export type Phase = "explore" | "implement";

export interface PhaseState {
  phase: Phase;
  /** Explore budget is measured in files read, not turns. */
  readonlyFilesRead: number;
  implementTurns: number;
  /** Consecutive non-mutating turns inside the implement phase. */
  consecutiveReadTurns: number;
  egressCount: number;
}

export const DEFAULT_EXPLORE_BUDGET = 30;
export const DEFAULT_IMPLEMENT_BUDGET = 30;
/** Consecutive pure-read turns inside implement that count as a retreat. */
export const IMPLEMENT_EGRESS_READ_TURNS = 2;

export const INITIAL_PHASE_STATE: PhaseState = {
  phase: "explore",
  readonlyFilesRead: 0,
  implementTurns: 0,
  consecutiveReadTurns: 0,
  egressCount: 0,
};

const READ_FILE_TOOLS = new Set(["read_file", "show_signature"]);

function readonlyFileReads(snapshot: TurnSnapshot): number {
  return snapshot.toolCalls.filter((call) => call.readonly && READ_FILE_TOOLS.has(call.name)).length;
}

/**
 * Advance the phase machine by one snapshot and produce the signals it fires.
 * Signals are event-shaped: they fire on transitions and threshold crossings,
 * not on every turn the condition holds.
 */
export function updatePhase(
  previous: PhaseState | undefined,
  snapshot: TurnSnapshot,
  budgets: { exploreBudget: number; implementBudget: number },
): { state: PhaseState; signals: ProgressSignal[] } {
  const state: PhaseState = previous ? { ...previous } : { ...INITIAL_PHASE_STATE };
  const signals: ProgressSignal[] = [];
  const mutated = snapshot.toolCalls.some((call) => call.mutated);

  if (state.phase === "explore") {
    state.readonlyFilesRead += readonlyFileReads(snapshot);
    if (mutated) {
      state.phase = "implement";
      state.consecutiveReadTurns = 0;
      return { state, signals };
    }
    if (
      state.readonlyFilesRead > budgets.exploreBudget &&
      previous !== undefined &&
      previous.readonlyFilesRead <= budgets.exploreBudget
    ) {
      signals.push({
        kind: "explore_budget",
        severity: "info",
        detail: `${state.readonlyFilesRead} files read (budget ${budgets.exploreBudget})`,
        sinceTurn: snapshot.turn,
      });
    }
    return { state, signals };
  }

  state.implementTurns += 1;
  if (mutated) {
    state.consecutiveReadTurns = 0;
    return { state, signals };
  }
  state.consecutiveReadTurns += 1;
  if (state.consecutiveReadTurns < IMPLEMENT_EGRESS_READ_TURNS) return { state, signals };

  state.phase = "explore";
  state.consecutiveReadTurns = 0;
  state.egressCount += 1;
  // The first retreat is informational; from the second on it is the warn
  // signal the gate layer injects.
  signals.push({
    kind: "phase_egress",
    severity: state.egressCount >= 2 ? "warn" : "info",
    detail: `${state.egressCount} time(s), back at turn ${snapshot.turn}`,
    sinceTurn: snapshot.turn,
  });
  return { state, signals };
}

/**
 * Explicitly exploration-shaped tasks ("research this module") widen the
 * mechanism-B criteria; the declaration is an artifact of the prompt, not an
 * automatic classification. A prompt that names a research verb *and* asks for
 * a change ("research this bug and fix it") is a delivery task: reading the
 * first marker alone would switch the convergence gate off for exactly the
 * tasks it is meant to cover.
 */
const EXPLORATION_MARKERS =
  /调研|研究|调查|梳理|\b(?:understand|investigate|research|explor\w*|survey|read[- ]?through)\b/i;
const DELIVERY_MARKERS =
  /修复|实现|添加|新增|改一下|改成|重构|优化|升级|\b(?:fix|implement|add|create|write|rename|refactor|rewrite|upgrade|migrate|optimi[sz]e)\b/i;

export function isExplorationTask(prompt: string): boolean {
  const head = prompt.slice(0, 400);
  return EXPLORATION_MARKERS.test(head) && !DELIVERY_MARKERS.test(head);
}
