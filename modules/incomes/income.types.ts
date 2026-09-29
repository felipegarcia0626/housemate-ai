export interface Income {
  id: string;
  householdId: string;
  createdBy: string;
  memberId: string;
  amount: number;
  incomeDate: string;
  description: string;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncomeListFilters {
  from?: string;
  to?: string;
  memberId?: string;
  categoryId?: string;
  macroId?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  page?: number;
  pageSize?: IncomePageSize;
  sortBy?: IncomeListSort;
  sortOrder?: IncomeSortOrder;
}

export type IncomePageSize = 25 | 50 | 100;

export type IncomeListSort = "incomeDate" | "amount" | "description";

export type IncomeSortOrder = "asc" | "desc";

export interface IncomeCreateInput {
  memberId: string;
  amount: number;
  incomeDate: string;
  description: string;
  categoryId?: string | null;
}

export interface IncomeUpdateInput {
  memberId?: string;
  amount?: number;
  incomeDate?: string;
  description?: string;
  categoryId?: string | null;
}

export interface IncomeServiceContext {
  householdId: string;
}

export interface IncomeCreateServiceContext extends IncomeServiceContext {
  memberId: string;
}

export interface IncomeListResult {
  incomes: Income[];
  pagination: {
    page: number;
    pageSize: IncomePageSize;
    total: number;
    totalPages: number;
  };
  summary: {
    totalIncome: number;
  };
}

export type IncomeDeleteOutcome = "DELETED";

export interface IncomeDeleteResult {
  id: string;
  result: IncomeDeleteOutcome;
}

export type IncomeDomainErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "HOUSEHOLD_MISMATCH"
  | "INCOME_REFERENCED"
  | "PERSISTENCE_ERROR";

export class IncomeDomainError extends Error {
  readonly code: IncomeDomainErrorCode;

  constructor(code: IncomeDomainErrorCode, message: string) {
    super(message);
    this.name = "IncomeDomainError";
    this.code = code;
  }
}
