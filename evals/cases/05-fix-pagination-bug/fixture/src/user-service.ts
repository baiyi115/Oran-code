import type { PaginationInput, User } from "./types.js";

const USERS: readonly User[] = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Linus" },
  { id: 3, name: "Grace" },
  { id: 4, name: "Margaret" },
  { id: 5, name: "Ken" },
  { id: 6, name: "Barbara" }
];

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

export function listUsers(input: PaginationInput = {}): User[] {
  const pageSize = input.pageSize ?? 2;
  const page = input.page ?? 1;
  requireNonNegativeInteger(pageSize, "pageSize");
  requireNonNegativeInteger(page, "page");
  if (page === 0) throw new RangeError("page must start at 1");

  if (input.offset !== undefined) {
    requireNonNegativeInteger(input.offset, "offset");
  }

  const start = input.offset ?? page * pageSize;
  return USERS.slice(start, start + pageSize);
}
