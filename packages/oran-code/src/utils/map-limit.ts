/**
 * Run `worker` over `items` with a bounded number in flight, returning the
 * results in input order.
 *
 * Used where the work is dominated by a round trip (a parse host request) and the
 * order of the merged output has to stay deterministic. The first failure stops
 * new items from starting and is re-thrown once the running ones settle, so a
 * rejected worker cannot turn into an unhandled rejection.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  let failure: unknown;

  const runners = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
    for (;;) {
      if (failure !== undefined) return;
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  });

  await Promise.all(runners);
  if (failure !== undefined) throw failure;
  return results;
}
