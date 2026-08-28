import { matchesKeyword } from './matcher.js';
import { normalizeKeyword, normalizeRange } from './normalize.js';
import type { CustomerPage, CustomerQuery } from './types.js';
import type { CustomerRepository } from './repository.js';

export class CustomerService {
  constructor(private readonly repository: CustomerRepository) {}

  listCustomers(query: CustomerQuery = {}): CustomerPage {
    const keyword = normalizeKeyword(query.keyword);
    const { offset, limit } = normalizeRange(query.offset, query.limit);
    const matched = this.repository.list()
      .filter((customer) => matchesKeyword(customer, keyword))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

    return {
      items: matched.slice(offset, offset + limit),
      total: matched.length,
      offset,
      limit,
    };
  }
}
