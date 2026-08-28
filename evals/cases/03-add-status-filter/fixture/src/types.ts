export type CustomerStatus = 'active' | 'paused' | 'closed';

export interface Customer {
  id: string;
  name: string;
  email: string;
  status: CustomerStatus;
  createdAt: string;
}

export interface CustomerQuery {
  keyword?: string;
  offset?: number;
  limit?: number;
}

export interface CustomerPage {
  items: Customer[];
  total: number;
  offset: number;
  limit: number;
}
