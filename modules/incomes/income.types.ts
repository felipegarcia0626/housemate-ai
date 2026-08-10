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
}

export interface IncomeServiceContext {
  householdId: string;
}

export interface IncomeListResult {
  incomes: Income[];
  summary: {
    totalIncome: number;
  };
}

export type IncomeDomainErrorCode =
  "VALIDATION_ERROR" | "HOUSEHOLD_MISMATCH" | "PERSISTENCE_ERROR";

export class IncomeDomainError extends Error {
  readonly code: IncomeDomainErrorCode;

  constructor(code: IncomeDomainErrorCode, message: string) {
    super(message);
    this.name = "IncomeDomainError";
    this.code = code;
  }
}
