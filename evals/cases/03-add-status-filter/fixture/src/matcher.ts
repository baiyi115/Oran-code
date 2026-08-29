import type { Customer } from "./types.js";

export function matchesKeyword(customer: Customer, keyword: string | undefined): boolean {
  if (!keyword) return true;
  return customer.name.toLocaleLowerCase().includes(keyword) || customer.email.toLocaleLowerCase().includes(keyword);
}
