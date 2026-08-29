import type { UserRecord } from "./models.js";

const users: readonly UserRecord[] = [
  { id: "u-100", alias: "amber", active: true },
  { id: "u-200", alias: "birch", active: false },
  { id: "u-300", alias: "cedar", active: true },
];

export function findUser(id: string): UserRecord | undefined {
  return users.find((user) => user.id === id);
}

export function listUsers(): readonly UserRecord[] {
  return users;
}
