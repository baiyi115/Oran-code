export interface RankedMatch<T> {
  readonly value: T;
  readonly score: number;
  readonly order: number;
}

export function fuzzyScore(query: string, candidate: string): number | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();
  if (!normalizedQuery) return 0;
  let cursor = 0;
  let score = 0;
  let previous = -1;
  for (const character of normalizedQuery) {
    const position = normalizedCandidate.indexOf(character, cursor);
    if (position < 0) return undefined;
    score += position === previous + 1 ? 4 : 1;
    if (position === 0 || /[\s\/_-]/.test(normalizedCandidate[position - 1] ?? "")) score += 3;
    previous = position;
    cursor = position + 1;
  }
  return score - (normalizedCandidate.length - normalizedQuery.length) * 0.001;
}

export function rankMatches<T>(query: string, values: readonly T[], text: (value: T) => string): T[] {
  return values
    .map((value, order): RankedMatch<T> | undefined => {
      const score = fuzzyScore(query, text(value));
      return score === undefined ? undefined : { value, score, order };
    })
    .filter((item): item is RankedMatch<T> => item !== undefined)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map((item) => item.value);
}
