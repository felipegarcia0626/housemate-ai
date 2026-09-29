import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import { getAvailableCategoryIds } from "@/modules/categories/category.repository";

import type {
  Expense,
  ExpenseCalculatedDistribution,
  ExpenseCategory,
  ExpenseCreateItemInput,
  ExpenseDeleteOutcome,
  ExpenseDistribution,
  ExpenseItem,
  ExpenseListCategory,
  ExpenseListDistribution,
  ExpenseListItem,
  ExpenseListMember,
  ExpenseListResult,
  ExpenseReadFilters,
  ExpenseSource,
  ExpenseStatus,
  ExpenseUpdateItemInput,
} from "./expense.types";

export type ExpenseRepositoryErrorKind =
  "INTEGRITY" | "NOT_FOUND" | "TECHNICAL";

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

export interface ExpenseUpdatePersistenceInput {
  householdId: string;
  expenseId: string;
  merchantIsSet: boolean;
  merchant: string | null;
  descriptionIsSet: boolean;
  description: string | null;
  totalAmount: number | null;
  expenseDate: string | null;
  paidByMemberId: string | null;
  categoryIdIsSet: boolean;
  categoryId: string | null;
  items: ExpenseUpdateItemInput[] | null;
  distributions: ExpenseCalculatedDistribution[] | null;
}

export interface ExpenseDeletePersistenceInput {
  householdId: string;
  expenseId: string;
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
  paid_by: string;
  total_amount: DatabaseNumeric;
  expense_date: string;
  description: string | null;
  created_at: string;
}

interface ExpenseListCategorySearchRow {
  id: string;
  parent_id: string | null;
  level: string | null;
}

interface ExpenseListMemberRow {
  id: string;
  display_name: string;
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

interface ExpenseListCategoryRow extends CategoryRow {
  parent_id: string | null;
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
    error.code === "P0002"
  ) {
    return "NOT_FOUND";
  }

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

function toListCategory(
  row: ExpenseListCategoryRow,
  parentName: string | null,
): ExpenseListCategory {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    parentName,
  };
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

async function getListCategoriesByIds(
  categoryIds: readonly string[],
): Promise<Map<string, ExpenseListCategory>> {
  const uniqueIds = [...new Set(categoryIds)];

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("tb_categories")
    .select("id,name,parent_id")
    .in("id", uniqueIds);

  if (error) {
    throw dataAccessError("load expense list categories", error);
  }

  const rows = (data ?? []) as ExpenseListCategoryRow[];
  const parentIds = [
    ...new Set(
      rows
        .map((row) => row.parent_id)
        .filter((parentId): parentId is string => parentId !== null),
    ),
  ];
  const parentNames = new Map<string, string>();

  if (parentIds.length > 0) {
    const { data: parentData, error: parentError } = await client
      .from("tb_categories")
      .select("id,name")
      .in("id", parentIds);

    if (parentError) {
      throw dataAccessError("load expense list category parents", parentError);
    }

    for (const parent of (parentData ?? []) as CategoryRow[]) {
      parentNames.set(parent.id.toLowerCase(), parent.name);
    }
  }

  return new Map(
    rows.map((row) => [
      row.id,
      toListCategory(
        row,
        row.parent_id === null
          ? null
          : (parentNames.get(row.parent_id.toLowerCase()) ?? null),
      ),
    ]),
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
  try {
    return await getAvailableCategoryIds(categoryIds, "EXPENSE");
  } catch (error) {
    throw dataAccessError("validate expense categories", error);
  }
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

export async function updateExpense(
  input: ExpenseUpdatePersistenceInput,
): Promise<string> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_update_expense",
    {
      p_household_id: input.householdId,
      p_expense_id: input.expenseId,
      p_set_merchant: input.merchantIsSet,
      p_merchant: input.merchant,
      p_set_description: input.descriptionIsSet,
      p_description: input.description,
      p_total_amount: input.totalAmount,
      p_expense_date: input.expenseDate,
      p_paid_by: input.paidByMemberId,
      p_set_category_id: input.categoryIdIsSet,
      p_category_id: input.categoryId,
      p_items:
        input.items === null
          ? null
          : input.items.map((item) => ({
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
      new Error("Unexpected fn_update_expense result"),
    );
  }

  return data;
}

export async function deleteExpense(
  input: ExpenseDeletePersistenceInput,
): Promise<ExpenseDeleteOutcome> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_delete_expense",
    {
      p_household_id: input.householdId,
      p_expense_id: input.expenseId,
    },
  );

  if (error) {
    throw new ExpenseRepositoryError(getPersistenceErrorKind(error), error);
  }

  if (
    data !== "DELETED" &&
    data !== "CANCELLED" &&
    data !== "ALREADY_CANCELLED"
  ) {
    throw new ExpenseRepositoryError(
      "TECHNICAL",
      new Error("Unexpected fn_delete_expense result"),
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

function emptyExpenseListResult(filters: ExpenseReadFilters): ExpenseListResult {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;

  return {
    data: [],
    pagination: { page, pageSize, total: 0, totalPages: 0 },
    summary: { totalCount: 0, totalAmount: 0 },
  };
}

async function getActiveMicroCategoryIdsForMacro(
  macroId: string,
): Promise<string[]> {
  const client = getSupabaseAdminClient();
  const { data: macro, error: macroError } = await client
    .from("tb_categories")
    .select("id")
    .eq("id", macroId)
    .eq("movement_type", "EXPENSE")
    .eq("level", "MACRO")
    .eq("is_active", true)
    .maybeSingle();

  if (macroError) {
    throw dataAccessError("validate expense category macro", macroError);
  }

  if (macro === null) {
    return [];
  }

  const { data: micros, error: microError } = await client
    .from("tb_categories")
    .select("id")
    .eq("parent_id", macroId)
    .eq("movement_type", "EXPENSE")
    .eq("level", "MICRO")
    .eq("is_active", true);

  if (microError) {
    throw dataAccessError("load expense macro categories", microError);
  }

  return (micros ?? []).map((row) => row.id as string);
}

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const EXPENSE_SUMMARY_FALLBACK_BATCH_SIZE = 500;

function isAggregateUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PGRST123"
  );
}

function toExpenseAmountCents(value: unknown): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Expense summary contains a non-finite amount.");
  }

  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("Expense summary contains an invalid amount.");
  }

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (match === null) {
    throw new Error("Expense summary contains an invalid amount.");
  }

  const fraction = match[3] ?? "";
  if (fraction.length > 2 && /[^0]/.test(fraction.slice(2))) {
    throw new Error("Expense summary contains an unsupported scale.");
  }

  const cents =
    BigInt(match[2]) * BigInt(100) +
    BigInt((fraction.slice(0, 2) + "00").slice(0, 2));
  return match[1] === "-" ? -cents : cents;
}

function centsToSafeExpenseAmount(cents: bigint): number {
  const absolute = cents < BigInt(0) ? -cents : cents;
  if (absolute > MAX_SAFE_CENTS) {
    throw new Error("Expense summary exceeds the safe numeric range.");
  }

  const amount = Number(cents) / 100;
  if (toExpenseAmountCents(amount) !== cents) {
    throw new Error("Expense summary cannot be represented without precision loss.");
  }

  return amount;
}

function readExpenseAggregateValue(
  data: unknown,
  totalCount: number,
): unknown {
  if (data === null || data === undefined) {
    if (totalCount === 0) return null;
    throw new Error("Expense summary aggregate is missing.");
  }

  if (!Array.isArray(data)) {
    throw new Error("Expense summary aggregate has an invalid shape.");
  }

  if (data.length === 0) {
    if (totalCount === 0) return null;
    throw new Error("Expense summary aggregate is empty.");
  }

  if (data.length !== 1 || typeof data[0] !== "object" || data[0] === null) {
    throw new Error("Expense summary aggregate has an invalid shape.");
  }

  const row = data[0] as Record<string, unknown>;
  const hasSum = Object.hasOwn(row, "sum");
  const hasLegacyTotal = Object.hasOwn(row, "total_amount");
  if (!hasSum && !hasLegacyTotal) {
    throw new Error("Expense summary aggregate is missing its value.");
  }

  const value = hasSum ? row.sum : row.total_amount;
  if (totalCount > 0 && (value === null || value === undefined)) {
    throw new Error("Expense summary aggregate is null for non-empty results.");
  }

  return value;
}

function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildExpenseSearchFilter(value: string): string {
  return quotePostgrestFilterValue(buildExpenseSearchPattern(value));
}

function buildExpenseSearchPattern(value: string): string {
  const escapedTerm = value.replace(/[\\%_*]/g, "\\$&");
  return `%${escapedTerm}%`;
}

async function getCategoryIdsForExpenseSearch(
  searchPattern: string,
): Promise<string[]> {
  const client = getSupabaseAdminClient();
  const { data: matchingData, error: matchingError } = await client
    .from("tb_categories")
    .select("id,parent_id,level")
    .eq("movement_type", "EXPENSE")
    .ilike("name", searchPattern);

  if (matchingError) {
    throw dataAccessError("search expense categories", matchingError);
  }

  const matchingRows = (matchingData ?? []) as ExpenseListCategorySearchRow[];
  const matchingMacroIds = matchingRows
    .filter((row) => row.level === "MACRO")
    .map((row) => row.id);
  let childRows: ExpenseListCategorySearchRow[] = [];

  if (matchingMacroIds.length > 0) {
    const { data, error } = await client
      .from("tb_categories")
      .select("id,parent_id,level")
      .eq("movement_type", "EXPENSE")
      .eq("level", "MICRO")
      .in("parent_id", matchingMacroIds);

    if (error) {
      throw dataAccessError("search expense macro categories", error);
    }

    childRows = (data ?? []) as ExpenseListCategorySearchRow[];
  }

  return [
    ...new Set([
      ...matchingRows.map((row) => row.id),
      ...childRows.map((row) => row.id),
    ]),
  ];
}

async function getExpenseListEnrichment(
  householdId: string,
  expenseRows: readonly ExpenseListRow[],
): Promise<{
  paidBy: Map<string, ExpenseListMember>;
  distributions: Map<string, ExpenseListDistribution[]>;
}> {
  const expenseIds = expenseRows.map((expense) => expense.id);
  if (expenseIds.length === 0) {
    return { paidBy: new Map(), distributions: new Map() };
  }

  const client = getSupabaseAdminClient();
  const { data: distributionData, error: distributionError } = await client
    .from("tb_expense_distributions")
    .select("expense_id,household_member_id,amount,percentage")
    .in("expense_id", expenseIds)
    .order("household_member_id", { ascending: true });

  if (distributionError) {
    throw dataAccessError("load expense list distributions", distributionError);
  }

  const distributionRows = (distributionData ?? []) as ExpenseDistributionRow[];
  const memberIds = [
    ...new Set([
      ...expenseRows.map((expense) => expense.paid_by),
      ...distributionRows.map((distribution) => distribution.household_member_id),
    ]),
  ];
  const { data: memberData, error: memberError } = await client
    .from("tb_household_members")
    .select("id,display_name")
    .eq("household_id", householdId)
    .in("id", memberIds);

  if (memberError) {
    throw dataAccessError("load expense list members", memberError);
  }

  const memberNames = new Map(
    ((memberData ?? []) as ExpenseListMemberRow[]).map((member) => [
      member.id.toLowerCase(),
      member.display_name,
    ]),
  );
  const getMemberName = (memberId: string): string => {
    const name = memberNames.get(memberId.toLowerCase());
    if (name === undefined) {
      throw dataAccessError(
        "map expense list member",
        new Error("Expense member is missing from the household."),
      );
    }
    return name;
  };
  const paidBy = new Map<string, ExpenseListMember>();
  for (const expense of expenseRows) {
    paidBy.set(expense.id, {
      memberId: expense.paid_by,
      name: getMemberName(expense.paid_by),
    });
  }

  const distributions = new Map<string, ExpenseListDistribution[]>();
  for (const distribution of distributionRows) {
    const current = distributions.get(distribution.expense_id) ?? [];
    current.push({
      memberId: distribution.household_member_id,
      memberName: getMemberName(distribution.household_member_id),
      percentage: toNumber(distribution.percentage),
      amount: toNumber(distribution.amount),
    });
    distributions.set(distribution.expense_id, current);
  }

  return { paidBy, distributions };
}

export async function listConfirmedExpensesCollection(
  householdId: string,
  filters: ExpenseReadFilters,
): Promise<ExpenseListResult> {
  const client = getSupabaseAdminClient();
  let expenseIds: string[] | undefined;

  if (filters.memberId !== undefined) {
    expenseIds = await getExpenseIdsForMember(filters.memberId);
    if (expenseIds.length === 0) {
      return emptyExpenseListResult(filters);
    }
  }

  let macroMicroIds: string[] | undefined;
  if (filters.macroId !== undefined) {
    macroMicroIds = await getActiveMicroCategoryIdsForMacro(filters.macroId);
    if (macroMicroIds.length === 0) {
      return emptyExpenseListResult(filters);
    }
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const sort = filters.sort ?? "date";
  const sortDirection = filters.sortDirection ?? "desc";
  const sortColumn =
    sort === "amount"
      ? "total_amount"
      : sort === "merchant"
        ? "merchant"
        : "expense_date";
  const ascending = sortDirection === "asc";
  const search =
    filters.search === undefined
      ? undefined
      : buildExpenseSearchFilter(filters.search);
  const searchCategoryIds =
    filters.search === undefined
      ? []
      : await getCategoryIdsForExpenseSearch(
          buildExpenseSearchPattern(filters.search),
        );

  const buildQuery = (columns: string) => {
    let query = client
      .from("tb_expenses")
      .select(columns, { count: "exact" })
      .eq("household_id", householdId)
      .eq("status", "CONFIRMED");

    if (filters.from !== undefined) query = query.gte("expense_date", filters.from);
    if (filters.to !== undefined) query = query.lte("expense_date", filters.to);
    if (filters.categoryId !== undefined) {
      query = query.eq("category_id", filters.categoryId);
    }
    if (filters.merchant !== undefined) query = query.eq("merchant", filters.merchant);
    if (filters.minAmount !== undefined) {
      query = query.gte("total_amount", filters.minAmount);
    }
    if (filters.maxAmount !== undefined) {
      query = query.lte("total_amount", filters.maxAmount);
    }
    if (expenseIds !== undefined) query = query.in("id", expenseIds);
    if (macroMicroIds !== undefined) {
      query = query.in("category_id", macroMicroIds);
    }
    if (search !== undefined) {
      const searchColumns = [
        `merchant.ilike.${search}`,
        `description.ilike.${search}`,
      ];
      if (searchCategoryIds.length > 0) {
        searchColumns.push(`category_id.in.(${searchCategoryIds.join(",")})`);
      }
      query = query.or(searchColumns.join(","));
    }

    return query;
  };

  const pageQuery = buildQuery(
    "id,category_id,merchant,paid_by,description,total_amount,expense_date,created_at",
  )
    .order(sortColumn, { ascending })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  const { data, error, count } = await pageQuery;

  if (error) {
    throw dataAccessError("list expenses", error);
  }

  if (count === null || !Number.isInteger(count) || count < 0) {
    throw dataAccessError(
      "count expenses",
      new Error("Expense summary count is unavailable."),
    );
  }
  const total = count;

  const sumExpenseAmountsInBatches = async (): Promise<bigint> => {
    let totalAmountCents = BigInt(0);
    let retrievedCount = 0;

    for (
      let from = 0;
      from < total;
      from += EXPENSE_SUMMARY_FALLBACK_BATCH_SIZE
    ) {
      const to = Math.min(
        from + EXPENSE_SUMMARY_FALLBACK_BATCH_SIZE,
        total,
      ) - 1;
      const { data: fallbackData, error: fallbackError } = await buildQuery(
        "total_amount",
      )
        .order("id", { ascending: true })
        .range(from, to);

      if (fallbackError !== null) {
        throw dataAccessError("summarize expenses", fallbackError);
      }

      const rows = (fallbackData ?? []) as unknown as Array<{
        total_amount: unknown;
      }>;
      const expectedBatchCount = to - from + 1;
      if (rows.length !== expectedBatchCount) {
        throw dataAccessError(
          "summarize expenses",
          new Error("Expense summary fallback returned an incomplete batch."),
        );
      }

      try {
        for (const row of rows) {
          totalAmountCents += toExpenseAmountCents(row.total_amount);
        }
      } catch (error) {
        throw dataAccessError("summarize expenses", error);
      }
      retrievedCount += rows.length;
    }

    if (retrievedCount !== total) {
      throw dataAccessError(
        "summarize expenses",
        new Error("Expense summary fallback returned an incomplete result."),
      );
    }

    return totalAmountCents;
  };

  const aggregateQuery = buildQuery("total_amount.sum()");
  const { data: aggregateData, error: aggregateError } = await aggregateQuery;
  let totalAmountCents: bigint;

  if (aggregateError !== null) {
    if (!isAggregateUnavailable(aggregateError)) {
      throw dataAccessError("summarize expenses", aggregateError);
    }

    // When PostgREST aggregates are unavailable, transfer only the amount column
    // for the same filtered rows in bounded internal batches.
    totalAmountCents = await sumExpenseAmountsInBatches();
  } else {
    try {
      const aggregateValue = readExpenseAggregateValue(aggregateData, total);
      totalAmountCents =
        aggregateValue === null || aggregateValue === undefined
          ? BigInt(0)
          : toExpenseAmountCents(aggregateValue);
    } catch (error) {
      throw dataAccessError("summarize expenses", error);
    }
  }

  let totalAmount: number;
  try {
    totalAmount = centsToSafeExpenseAmount(totalAmountCents);
  } catch (error) {
    throw dataAccessError("serialize expense summary", error);
  }
  const expenseRows = (data ?? []) as unknown as ExpenseListRow[];
  const categoryIds = expenseRows
    .map((expense) => expense.category_id)
    .filter((categoryId): categoryId is string => categoryId !== null);
  const categories = await getListCategoriesByIds(categoryIds);
  const enrichment = await getExpenseListEnrichment(householdId, expenseRows);

  return {
    data: expenseRows.map((expense) => ({
      id: expense.id,
      merchant: expense.merchant,
      description: expense.description,
      totalAmount: toNumber(expense.total_amount),
      expenseDate: expense.expense_date,
      category:
        expense.category_id === null
          ? null
          : (categories.get(expense.category_id) ?? null),
      paidBy: enrichment.paidBy.get(expense.id) ?? null,
      distributions: enrichment.distributions.get(expense.id) ?? [],
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
    summary: { totalCount: total, totalAmount },
  };
}
