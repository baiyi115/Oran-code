/**
 * Structured rehearsal (mechanism B2): when the exploration budget runs out,
 * the model is not stopped — it must state a machine-comparable summary.
 * Convergence is judged monotonically: a candidate set that keeps the same
 * size while changing content is guessing, and an unparseable answer counts
 * as divergence.
 */

export interface RehearsalData {
  hypothesis: string;
  excluded: string[];
  candidateSet: string[];
  nextCheck: string;
}

export type Convergence = "converged" | "diverged";

export function rehearsalRequestNotice(first: boolean): string {
  const urgency = first
    ? "Before continuing to read files, output a structured status rehearsal."
    : "The previous rehearsal did not converge. Output the rehearsal again, with a candidate set that actually shrinks or a strictly growing exclusion list.";
  return (
    `${urgency} Reply with a JSON object (it may be inside a code fence) with exactly these fields:\n` +
    '{"hypothesis": "<current best explanation>", "excluded": ["<ruled-out files/dirs>"], ' +
    '"candidateSet": ["<remaining candidates>"], "nextCheck": "<the one check that would decide next>"}.\n' +
    "The candidate set must shrink monotonically versus your previous rehearsal, or the exclusion list must strictly grow."
  );
}

/** Extract and validate the rehearsal JSON from a model reply. */
export function parseRehearsal(text: string): RehearsalData | undefined {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const bare = text.match(/\{[\s\S]*\}/g) ?? [];
  candidates.push(...bare.reverse());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<RehearsalData>;
      if (
        typeof parsed.hypothesis === "string" &&
        typeof parsed.nextCheck === "string" &&
        Array.isArray(parsed.excluded) &&
        Array.isArray(parsed.candidateSet) &&
        parsed.excluded.every((item) => typeof item === "string") &&
        parsed.candidateSet.every((item) => typeof item === "string")
      ) {
        return {
          hypothesis: parsed.hypothesis,
          excluded: parsed.excluded,
          candidateSet: parsed.candidateSet,
          nextCheck: parsed.nextCheck,
        };
      }
    } catch {
      // Try the next candidate block.
    }
  }
  return undefined;
}

export function judgeConvergence(previous: RehearsalData | undefined, current: RehearsalData): Convergence {
  if (!previous) {
    // First rehearsal: accept it as a baseline (it did the work of stating one).
    return "converged";
  }
  // Monotonic contraction: the candidate set must shrink within the previous
  // one. A same-sized swap (even disjoint content) or a growing set is
  // guessing, not converging.
  const previousSet = new Set(previous.candidateSet);
  const contained = current.candidateSet.every((item) => previousSet.has(item));
  if (contained && current.candidateSet.length < previous.candidateSet.length) return "converged";
  if (current.excluded.length > previous.excluded.length) return "converged";
  return "diverged";
}
