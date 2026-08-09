export type ExpenseStatus = "PENDING" | "CONFIRMED" | "CANCELLED";

export type ExpenseSource = "WEB" | "WHATSAPP" | "RECEIPT";

export interface ExpenseCategory {
  id: string;
  name: string;
}

export interface ExpenseItem {
  id: string;
  expenseId: string;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  totalAmount: number;
  category: ExpenseCategory | null;
  createdAt: string;
}

export interface ExpenseDistribution {
  id: string;
  expenseId: string;
  householdMemberId: string;
  amount: number;
  percentage: number;
}

export interface Expense {
  id: string;
  householdId: string;
  createdBy: string;
  paidByMemberId: string;
  category: ExpenseCategory | null;
  merchant: string;
  totalAmount: number;
  currency: "COP";
  expenseDate: string;
  description: string | null;
  status: ExpenseStatus;
  source: ExpenseSource;
  items: ExpenseItem[];
  distributions: ExpenseDistribution[];
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseListItem {
  id: string;
  merchant: string;
  totalAmount: number;
  expenseDate: string;
  category: ExpenseCategory | null;
}

export interface ExpenseReadFilters {
  from?: string;
  to?: string;
  categoryId?: string;
  memberId?: string;
  merchant?: string;
  minAmount?: number;
  maxAmount?: number;
}

export interface ExpenseServiceContext {
  householdId: string;
}

export type ExpenseDomainErrorCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "HOUSEHOLD_MISMATCH";

export class ExpenseDomainError extends Error {
  readonly code: ExpenseDomainErrorCode;

  constructor(code: ExpenseDomainErrorCode, message: string) {
    super(message);
    this.name = "ExpenseDomainError";
    this.code = code;
  }
}
