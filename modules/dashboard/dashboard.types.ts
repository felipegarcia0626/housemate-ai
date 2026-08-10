export interface DashboardFilters {
  from?: string;
  to?: string;
}

export interface DashboardServiceContext {
  householdId: string;
}

export interface DashboardMemberIncome {
  memberId: string;
  amount: number;
}

export interface DashboardCategoryAmount {
  categoryId: string | null;
  categoryName: string | null;
  amount: number;
}

export interface DashboardResult {
  totalIncome: number;
  totalSpent: number;
  netAmount: number;
  expenseCount: number;
  memberIncome: DashboardMemberIncome[];
  byCategory: DashboardCategoryAmount[];
}

export interface DashboardIncomeRow {
  memberId: string;
  amount: string;
}

export interface DashboardExpenseItemRow {
  totalAmount: string;
  categoryId: string | null;
  categoryName: string | null;
}

export interface DashboardExpenseRow {
  totalAmount: string;
  categoryId: string | null;
  categoryName: string | null;
  items: DashboardExpenseItemRow[];
}

export type DashboardDomainErrorCode = "VALIDATION_ERROR" | "PERSISTENCE_ERROR";

export class DashboardDomainError extends Error {
  readonly code: DashboardDomainErrorCode;

  constructor(code: DashboardDomainErrorCode, message: string) {
    super(message);
    this.name = "DashboardDomainError";
    this.code = code;
  }
}
