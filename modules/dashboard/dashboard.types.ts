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

export type ExpenseCategorySummaryLevel = "MACRO" | "MICRO";

export interface DashboardCategoryTaxonomyRow {
  id: string;
  name: string;
  movementType: string | null;
  level: string | null;
  parentId: string | null;
  isActive: boolean;
}

export interface PeriodExpenseCategoryData {
  expenses: DashboardExpenseRow[];
  categories: DashboardCategoryTaxonomyRow[];
  expenseCount: number;
  itemCount: number;
}

export interface PeriodFinancialCategoryData {
  incomeCount: number;
  incomeAmount: string;
  categoryData: PeriodExpenseCategoryData;
}

export interface ExpenseCategorySummaryEntry {
  categoryName: string;
  amount: number;
  isActive: boolean;
}

export type ExpenseCategorySummaryFailureReason =
  | "INVALID_ARGUMENTS"
  | "PERIOD_TOO_LONG"
  | "CATEGORY_UNRESOLVED"
  | "CATEGORY_AMBIGUOUS"
  | "CATEGORY_INACTIVE"
  | "INCOMPLETE";

export interface PeriodExpenseCategorySummary {
  from: string;
  to: string;
  level: ExpenseCategorySummaryLevel | null;
  categoryName: string | null;
  complete: boolean;
  failureReason?: ExpenseCategorySummaryFailureReason;
  totalSpent?: number;
  expenseCount?: number;
  categories?: ExpenseCategorySummaryEntry[];
  topCategory?: ExpenseCategorySummaryEntry | null;
  matchedCategory?: ExpenseCategorySummaryEntry | null;
  uncategorizedAmount?: number;
  unmappedAmount?: number;
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
