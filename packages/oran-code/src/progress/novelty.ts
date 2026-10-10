import type { ProgressSignal } from "./signals.js";

/**
 * Symbol novelty (mechanism B1): fingerprint criteria cannot see "keeps
 * reading different files but learns nothing" — novelty of the symbols read
 * can. Source is layered: graph symbols when the file is covered by the code
 * impact graph's symbol table, otherwise a text regex (an over-approximation
 * that errs toward counting progress, i.e. the safe direction: stalls are
 * found later, never falsely).
 */

export const NOVELTY_THRESHOLD = 0.1;
export const NOVELTY_LOW_RUN = 5;
/** EMA smoothing constant: weight of the newest observation is 1/K. */
export const NOVELTY_EMA_K = 5;
const MAX_KNOWN_SYMBOLS = 5000;
const MAX_SYMBOLS_PER_READ = 200;

export interface NoveltyState {
  known: string[];
  ema: number | undefined;
  lowRun: number;
  /** Which source produced the latest measurement; the two are not comparable. */
  source: "graph" | "regex";
}

export const INITIAL_NOVELTY_STATE: NoveltyState = { known: [], ema: undefined, lowRun: 0, source: "regex" };

export interface NoveltyRead {
  file: string;
  /** Graph symbols for the file, when available. */
  graphSymbols?: string[] | undefined;
  /** Raw text fallback for the regex layer. */
  text: string;
}

const REGEX_PATTERNS: RegExp[] = [
  /\b(?:function|class|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bdef\s+([A-Za-z_]\w*)/g,
  /\bfn\s+([A-Za-z_]\w*)/g,
  /\btype\s+([A-Za-z_$][\w$]*)\s*=/g,
];

function regexSymbols(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of REGEX_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match && names.size < MAX_SYMBOLS_PER_READ; match = pattern.exec(text)) {
      if (match[1]) names.add(match[1]);
    }
    if (names.size >= MAX_SYMBOLS_PER_READ) break;
  }
  return [...names];
}

export function updateNovelty(
  previous: NoveltyState | undefined,
  reads: readonly NoveltyRead[],
): { state: NoveltyState; signal: ProgressSignal | undefined } {
  const state: NoveltyState = previous
    ? { ...previous, known: [...previous.known] }
    : { ...INITIAL_NOVELTY_STATE, known: [] };

  let total = 0;
  let fresh = 0;
  let graphCovered = 0;
  const knownSet = new Set(state.known);
  for (const read of reads) {
    const symbols =
      read.graphSymbols !== undefined ? read.graphSymbols.slice(0, MAX_SYMBOLS_PER_READ) : regexSymbols(read.text);
    if (read.graphSymbols !== undefined) graphCovered += 1;
    for (const name of symbols) {
      total += 1;
      if (!knownSet.has(name)) {
        fresh += 1;
        knownSet.add(name);
      }
    }
  }
  state.source = graphCovered > 0 ? "graph" : "regex";

  let signal: ProgressSignal | undefined;
  if (total === 0) return { state, signal };

  const novelty = fresh / total;
  state.ema = state.ema === undefined ? novelty : novelty / NOVELTY_EMA_K + state.ema * (1 - 1 / NOVELTY_EMA_K);
  if (novelty < NOVELTY_THRESHOLD) state.lowRun += 1;
  else state.lowRun = 0;

  if (state.lowRun >= NOVELTY_LOW_RUN) {
    signal = {
      kind: "low_symbol_novelty",
      severity: "warn",
      detail: `novelty ${state.ema?.toFixed(3)} below ${NOVELTY_THRESHOLD} for ${state.lowRun} turns (source: ${state.source})`,
      sinceTurn: 0,
    };
  }
  // Always re-store the trimmed set. Guarding this on the *previous* length
  // froze the set at the cap: every symbol read afterwards was no longer
  // remembered, so each turn counted them as fresh, novelty stayed near 1, and
  // the lowRun counter could never reach its threshold again.
  state.known = [...knownSet].slice(-MAX_KNOWN_SYMBOLS);
  return { state, signal };
}
