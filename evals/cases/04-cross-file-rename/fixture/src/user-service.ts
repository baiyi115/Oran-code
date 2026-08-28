import type { UserSummary } from "./models.js";
import { findUser, listUsers } from "./user-repository.js";

export function getUserSummary(id: string): UserSummary | undefined {
  const user = findUser(id);
  if (!user) return undefined;

  return { id: user.id, alias: user.alias };
}

export function listActiveUserSummaries(): UserSummary[] {
  return listUsers()
    .filter((user) => user.active)
    .map((user) => ({ id: user.id, alias: user.alias }));
}
