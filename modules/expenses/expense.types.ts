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
  merchant: string | null;
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
  merchant: string | null;
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

export interface ExpenseCreateItemInput {
  name: string;
  quantity?: number | null;
  unitPrice?: number | null;
  totalAmount: number;
  categoryId?: string | null;
}

export interface ExpenseCreateSplitInput {
  householdMemberId: string;
  percentage: number;
}

export interface ExpenseCreateInput {
  createdBy: string;
  paidByMemberId: string;
  categoryId?: string | null;
  receiptId?: string | null;
  merchant?: string | null;
  totalAmount: number;
  expenseDate: string;
  description?: string | null;
  source: ExpenseSource;
  items?: ExpenseCreateItemInput[];
  splits: ExpenseCreateSplitInput[];
}

export type ExpenseUpdateItemInput = ExpenseCreateItemInput;

export type ExpenseUpdateSplitInput = ExpenseCreateSplitInput;

export interface ExpenseUpdateInput {
  merchant?: string | null;
  description?: string | null;
  totalAmount?: number;
  expenseDate?: string;
  paidByMemberId?: string;
  categoryId?: string | null;
  items?: ExpenseUpdateItemInput[];
  splits?: ExpenseUpdateSplitInput[];
}

export interface ExpenseCalculatedDistribution {
  householdMemberId: string;
  amount: number;
  percentage: number;
}

export interface ExpenseServiceContext {
  householdId: string;
}

export type ExpenseDomainErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "HOUSEHOLD_MISMATCH"
  | "PERSISTENCE_ERROR"
  | "CREATED_NOT_HYDRATED"
  | "UPDATED_NOT_HYDRATED";

export class ExpenseDomainError extends Error {
  readonly code: ExpenseDomainErrorCode;

  constructor(code: ExpenseDomainErrorCode, message: string) {
    super(message);
    this.name = "ExpenseDomainError";
    this.code = code;
  }
}

export class ExpenseCreatedNotHydratedError extends ExpenseDomainError {
  readonly expenseId: string;

  constructor(expenseId: string) {
    super(
      "CREATED_NOT_HYDRATED",
      "Expense was created but could not be loaded.",
    );
    this.name = "ExpenseCreatedNotHydratedError";
    this.expenseId = expenseId;
  }
}

export class ExpenseUpdatedNotHydratedError extends ExpenseDomainError {
  readonly expenseId: string;

  constructor(expenseId: string) {
    super(
      "UPDATED_NOT_HYDRATED",
      "Expense was updated but could not be loaded.",
    );
    this.name = "ExpenseUpdatedNotHydratedError";
    this.expenseId = expenseId;
  }
}
