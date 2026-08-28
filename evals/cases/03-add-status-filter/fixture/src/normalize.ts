export function normalizeKeyword(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized ? normalized : undefined;
}

export function normalizeRange(offset = 0, limit = 20): { offset: number; limit: number } {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
  return { offset, limit };
}
