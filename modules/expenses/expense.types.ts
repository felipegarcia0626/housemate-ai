export type ExpenseStatus = "PENDING" | "CONFIRMED" | "CANCELLED";

export type ExpenseSource = "WEB" | "WHATSAPP" | "RECEIPT";

export interface ExpenseCategory {
  id: string;
  name: string;
}

export interface ExpenseListCategory extends ExpenseCategory {
  parentId?: string | null;
  parentName?: string | null;
}

export interface ExpenseListMember {
  memberId: string;
  name: string;
}

export interface ExpenseListDistribution {
  memberId: string;
  memberName: string;
  percentage: number;
  amount: number;
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
  description?: string | null;
  totalAmount: number;
  expenseDate: string;
  category: ExpenseListCategory | null;
  paidBy?: ExpenseListMember | null;
  distributions?: ExpenseListDistribution[];
}

export type ExpenseListSort = "date" | "amount" | "merchant";

export type ExpenseSortDirection = "asc" | "desc";

export type ExpensePageSize = 25 | 50 | 100;

export interface ExpenseReadFilters {
  from?: string;
  to?: string;
  categoryId?: string;
  memberId?: string;
  merchant?: string;
  minAmount?: number;
  maxAmount?: number;
  page?: number;
  pageSize?: ExpensePageSize;
  search?: string;
  macroId?: string;
  sort?: ExpenseListSort;
  sortDirection?: ExpenseSortDirection;
}

export interface ExpenseListPagination {
  page: number;
  pageSize: ExpensePageSize;
  total: number;
  totalPages: number;
}

export interface ExpenseListSummary {
  totalCount: number;
  totalAmount: number;
}

export interface ExpenseListResult {
  data: ExpenseListItem[];
  pagination: ExpenseListPagination;
  summary: ExpenseListSummary;
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

export type ExpenseDeleteOutcome =
  "DELETED" | "CANCELLED" | "ALREADY_CANCELLED";

export interface ExpenseDeleteResult {
  id: string;
  result: ExpenseDeleteOutcome;
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
