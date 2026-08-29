import type { Customer } from "./types.js";

export interface CustomerRepository {
  list(): readonly Customer[];
}

export class MemoryCustomerRepository implements CustomerRepository {
  readonly #customers: readonly Customer[];

  constructor(customers: readonly Customer[]) {
    this.#customers = customers.map((customer) => ({ ...customer }));
  }

  list(): readonly Customer[] {
    return this.#customers.map((customer) => ({ ...customer }));
  }
}
