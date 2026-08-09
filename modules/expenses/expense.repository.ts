import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type {
  Expense,
  ExpenseCalculatedDistribution,
  ExpenseCategory,
  ExpenseCreateItemInput,
  ExpenseDistribution,
  ExpenseItem,
  ExpenseListItem,
  ExpenseReadFilters,
  ExpenseSource,
  ExpenseStatus,
} from "./expense.types";

export type ExpenseRepositoryErrorKind = "INTEGRITY" | "TECHNICAL";

export class ExpenseRepositoryError extends Error {
  readonly kind: ExpenseRepositoryErrorKind;

  constructor(kind: ExpenseRepositoryErrorKind, cause: unknown) {
    super("Unable to persist Expense.", { cause });
    this.name = "ExpenseRepositoryError";
    this.kind = kind;
  }
}

export interface ExpenseCreatePersistenceInput {
  householdId: string;
  createdBy: string;
  paidByMemberId: string;
  categoryId: string | null;
  receiptId: string | null;
  merchant: string | null;
  totalAmount: number;
  expenseDate: string;
  description: string | null;
  source: ExpenseSource;
  items: ExpenseCreateItemInput[];
  distributions: ExpenseCalculatedDistribution[];
}

type DatabaseNumeric = number | string;

interface ExpenseRow {
  id: string;
  household_id: string;
  created_by: string;
  paid_by: string;
  category_id: string | null;
  merchant: string | null;
  total_amount: DatabaseNumeric;
  currency: string;
  expense_date: string;
  description: string | null;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface ExpenseListRow {
  id: string;
  category_id: string | null;
  merchant: string | null;
  total_amount: DatabaseNumeric;
  expense_date: string;
}

interface ExpenseItemRow {
  id: string;
  expense_id: string;
  name: string;
  quantity: DatabaseNumeric | null;
  unit_price: DatabaseNumeric | null;
  total_amount: DatabaseNumeric;
  category_id: string | null;
  created_at: string;
}

interface ExpenseDistributionRow {
  id: string;
  expense_id: string;
  household_member_id: string;
  amount: DatabaseNumeric;
  percentage: DatabaseNumeric;
}

interface CategoryRow {
  id: string;
  name: string;
}

export interface ExpenseReceiptForCreation {
  id: string;
  householdId: string;
  processingStatus: string;
  expenseId: string | null;
}

interface ExpenseReceiptForCreationRow {
  id: string;
  household_id: string;
  processing_status: string;
  expense_id: string | null;
}

function dataAccessError(operation: string, cause: unknown): Error {
  return new Error(`Unable to ${operation}.`, { cause });
}

function getPersistenceErrorKind(error: unknown): ExpenseRepositoryErrorKind {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    ["22023", "22P02", "23503", "23505", "23514"].includes(error.code)
  ) {
    return "INTEGRITY";
  }

  return "TECHNICAL";
}

function toNumber(value: DatabaseNumeric): number {
  return typeof value === "number" ? value : Number(value);
}

function toExpenseStatus(value: string): ExpenseStatus {
  if (value === "PENDING" || value === "CONFIRMED" || value === "CANCELLED") {
    return value;
  }

  throw dataAccessError("map expense status", new Error("Unexpected status"));
}

function toExpenseSource(value: string): ExpenseSource {
  if (value === "WEB" || value === "WHATSAPP" || value === "RECEIPT") {
    return value;
  }

  throw dataAccessError("map expense source", new Error("Unexpected source"));
}

function toCategory(row: CategoryRow): ExpenseCategory {
  return { id: row.id, name: row.name };
}

async function getCategoriesByIds(
  categoryIds: readonly string[],
): Promise<Map<string, ExpenseCategory>> {
  const uniqueIds = [...new Set(categoryIds)];

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id,name")
    .in("id", uniqueIds);

  if (error) {
    throw dataAccessError("load expense categories", error);
  }

  return new Map(
    ((data ?? []) as CategoryRow[]).map((row) => [row.id, toCategory(row)]),
  );
}

function mapExpenseItem(
  row: ExpenseItemRow,
  categories: ReadonlyMap<string, ExpenseCategory>,
): ExpenseItem {
  return {
    id: row.id,
    expenseId: row.expense_id,
    name: row.name,
    quantity: row.quantity === null ? null : toNumber(row.quantity),
    unitPrice: row.unit_price === null ? null : toNumber(row.unit_price),
    totalAmount: toNumber(row.total_amount),
    category:
      row.category_id === null
        ? null
        : (categories.get(row.category_id) ?? null),
    createdAt: row.created_at,
  };
}

function mapExpenseDistribution(
  row: ExpenseDistributionRow,
): ExpenseDistribution {
  return {
    id: row.id,
    expenseId: row.expense_id,
    householdMemberId: row.household_member_id,
    amount: toNumber(row.amount),
    percentage: toNumber(row.percentage),
  };
}

export async function findExpenseById(
  householdId: string,
  expenseId: string,
): Promise<Expense | null> {
  const client = getSupabaseAdminClient();
  const { data: expenseData, error: expenseError } = await client
    .from("tb_expenses")
    .select(
      "id,household_id,created_by,paid_by,category_id,merchant,total_amount,currency,expense_date,description,status,source,created_at,updated_at",
    )
    .eq("household_id", householdId)
    .eq("id", expenseId)
    .maybeSingle();

  if (expenseError) {
    throw dataAccessError("load expense", expenseError);
  }

  if (expenseData === null) {
    return null;
  }

  const expenseRow = expenseData as ExpenseRow;
  const [itemsResult, distributionsResult] = await Promise.all([
    client
      .from("tb_expense_items")
      .select(
        "id,expense_id,name,quantity,unit_price,total_amount,category_id,created_at",
      )
      .eq("expense_id", expenseRow.id)
      .order("created_at", { ascending: true }),
    client
      .from("tb_expense_distributions")
      .select("id,expense_id,household_member_id,amount,percentage")
      .eq("expense_id", expenseRow.id)
      .order("household_member_id", { ascending: true }),
  ]);

  if (itemsResult.error) {
    throw dataAccessError("load expense items", itemsResult.error);
  }

  if (distributionsResult.error) {
    throw dataAccessError(
      "load expense distributions",
      distributionsResult.error,
    );
  }

  const itemRows = (itemsResult.data ?? []) as ExpenseItemRow[];
  const categoryIds = [
    expenseRow.category_id,
    ...itemRows.map((item) => item.category_id),
  ].filter((categoryId): categoryId is string => categoryId !== null);
  const categories = await getCategoriesByIds(categoryIds);

  if (expenseRow.currency !== "COP") {
    throw dataAccessError(
      "map expense currency",
      new Error("Unexpected currency"),
    );
  }

  return {
    id: expenseRow.id,
    householdId: expenseRow.household_id,
    createdBy: expenseRow.created_by,
    paidByMemberId: expenseRow.paid_by,
    category:
      expenseRow.category_id === null
        ? null
        : (categories.get(expenseRow.category_id) ?? null),
    merchant: expenseRow.merchant,
    totalAmount: toNumber(expenseRow.total_amount),
    currency: "COP",
    expenseDate: expenseRow.expense_date,
    description: expenseRow.description,
    status: toExpenseStatus(expenseRow.status),
    source: toExpenseSource(expenseRow.source),
    items: itemRows.map((item) => mapExpenseItem(item, categories)),
    distributions: (
      (distributionsResult.data ?? []) as ExpenseDistributionRow[]
    ).map(mapExpenseDistribution),
    createdAt: expenseRow.created_at,
    updatedAt: expenseRow.updated_at,
  };
}

export async function isHouseholdMemberInHousehold(
  householdId: string,
  householdMemberId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId)
    .eq("id", householdMemberId)
    .maybeSingle();

  if (error) {
    throw dataAccessError("validate household member", error);
  }

  return data !== null;
}

export async function getHouseholdMemberIds(
  householdId: string,
  householdMemberIds: readonly string[],
): Promise<Set<string>> {
  const uniqueIds = [...new Set(householdMemberIds)];

  if (uniqueIds.length === 0) {
    return new Set();
  }

  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId)
    .in("id", uniqueIds);

  if (error) {
    throw dataAccessError("validate household members", error);
  }

  return new Set((data ?? []).map((row) => (row.id as string).toLowerCase()));
}

export async function getExistingCategoryIds(
  categoryIds: readonly string[],
): Promise<Set<string>> {
  const uniqueIds = [...new Set(categoryIds)];

  if (uniqueIds.length === 0) {
    return new Set();
  }

  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id")
    .in("id", uniqueIds);

  if (error) {
    throw dataAccessError("validate expense categories", error);
  }

  return new Set((data ?? []).map((row) => (row.id as string).toLowerCase()));
}

export async function findReceiptForExpenseCreation(
  receiptId: string,
): Promise<ExpenseReceiptForCreation | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_receipts")
    .select("id,household_id,processing_status,expense_id")
    .eq("id", receiptId)
    .maybeSingle();

  if (error) {
    throw dataAccessError("validate expense receipt", error);
  }

  if (data === null) {
    return null;
  }

  const row = data as ExpenseReceiptForCreationRow;

  return {
    id: row.id,
    householdId: row.household_id,
    processingStatus: row.processing_status,
    expenseId: row.expense_id,
  };
}

export async function createExpense(
  input: ExpenseCreatePersistenceInput,
): Promise<string> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_create_expense",
    {
      p_household_id: input.householdId,
      p_created_by: input.createdBy,
      p_paid_by: input.paidByMemberId,
      p_category_id: input.categoryId,
      p_receipt_id: input.receiptId,
      p_merchant: input.merchant,
      p_total_amount: input.totalAmount,
      p_expense_date: input.expenseDate,
      p_description: input.description,
      p_source: input.source,
      p_items: input.items.map((item) => ({
        name: item.name,
        quantity: item.quantity ?? null,
        unitPrice: item.unitPrice ?? null,
        totalAmount: item.totalAmount,
        categoryId: item.categoryId ?? null,
      })),
      p_distributions: input.distributions,
    },
  );

  if (error) {
    throw new ExpenseRepositoryError(getPersistenceErrorKind(error), error);
  }

  if (typeof data !== "string") {
    throw new ExpenseRepositoryError(
      "TECHNICAL",
      new Error("Unexpected fn_create_expense result"),
    );
  }

  return data;
}

async function getExpenseIdsForMember(memberId: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_expense_distributions")
    .select("expense_id")
    .eq("household_member_id", memberId);

  if (error) {
    throw dataAccessError("filter expenses by household member", error);
  }

  return (data ?? []).map((row) => row.expense_id as string);
}

export async function listConfirmedExpenses(
  householdId: string,
  filters: ExpenseReadFilters,
): Promise<ExpenseListItem[]> {
  const client = getSupabaseAdminClient();
  let expenseIds: string[] | undefined;

  if (filters.memberId !== undefined) {
    expenseIds = await getExpenseIdsForMember(filters.memberId);

    if (expenseIds.length === 0) {
      return [];
    }
  }

  let query = client
    .from("tb_expenses")
    .select("id,category_id,merchant,total_amount,expense_date")
    .eq("household_id", householdId)
    .eq("status", "CONFIRMED")
    .order("expense_date", { ascending: false });

  if (filters.from !== undefined) {
    query = query.gte("expense_date", filters.from);
  }

  if (filters.to !== undefined) {
    query = query.lte("expense_date", filters.to);
  }

  if (filters.categoryId !== undefined) {
    query = query.eq("category_id", filters.categoryId);
  }

  if (filters.merchant !== undefined) {
    query = query.eq("merchant", filters.merchant);
  }

  if (filters.minAmount !== undefined) {
    query = query.gte("total_amount", filters.minAmount);
  }

  if (filters.maxAmount !== undefined) {
    query = query.lte("total_amount", filters.maxAmount);
  }

  if (expenseIds !== undefined) {
    query = query.in("id", expenseIds);
  }

  const { data, error } = await query;

  if (error) {
    throw dataAccessError("list expenses", error);
  }

  const expenseRows = (data ?? []) as ExpenseListRow[];
  const categoryIds = expenseRows
    .map((expense) => expense.category_id)
    .filter((categoryId): categoryId is string => categoryId !== null);
  const categories = await getCategoriesByIds(categoryIds);

  return expenseRows.map((expense) => ({
    id: expense.id,
    merchant: expense.merchant,
    totalAmount: toNumber(expense.total_amount),
    expenseDate: expense.expense_date,
    category:
      expense.category_id === null
        ? null
        : (categories.get(expense.category_id) ?? null),
  }));
}
