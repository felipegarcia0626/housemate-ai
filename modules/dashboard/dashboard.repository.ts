import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type {
  DashboardExpenseRow,
  DashboardFilters,
  DashboardIncomeRow,
  DashboardCategoryTaxonomyRow,
  PeriodExpenseCategoryData,
  PeriodFinancialCategoryData,
} from "./dashboard.types";

interface DashboardCategoryRelation {
  id: string;
  name: string;
}

interface DashboardIncomeDatabaseRow {
  member_id: string;
  amount: string;
}

interface DashboardExpenseItemDatabaseRow {
  total_amount: string;
  category_id: string | null;
  category: DashboardCategoryRelation | null;
}

interface DashboardExpenseDatabaseRow {
  total_amount: string;
  category_id: string | null;
  category: DashboardCategoryRelation | null;
  items: DashboardExpenseItemDatabaseRow[] | null;
}

export class DashboardRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to load Dashboard data.", { cause });
    this.name = "DashboardRepositoryError";
  }
}

export interface PeriodFinancialSnapshot {
  incomeCount: number;
  expenseCount: number;
  incomeAmount: string;
  expenseAmount: string;
}

const MAX_PERIOD_ROWS_PER_KIND = 5000;
const PERIOD_SUMMARY_PAGE_SIZE = 500;

function amountToCents(value: unknown): bigint {
  if (typeof value !== "string") {
    throw new DashboardRepositoryError(new Error("Invalid financial amount type."));
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new DashboardRepositoryError(new Error("Invalid financial amount."));
  }
  return BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function centsToAmount(value: bigint): string {
  const units = value / BigInt(100);
  const cents = (value % BigInt(100)).toString().padStart(2, "0");
  return `${units}.${cents}`;
}

async function readPeriodAmountCollection(
  table: "tb_expenses" | "tb_incomes",
  amountColumn: "total_amount" | "amount",
  dateColumn: "expense_date" | "income_date",
  householdId: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<{ count: number; amount: string }> {
  let offset = 0;
  let total: number | null = null;
  let totalCents = BigInt(0);

  do {
    let query = getSupabaseAdminClient()
      .from(table)
      .select(`${amountColumn}::text`, { count: "exact" })
      .eq("household_id", householdId)
      .gte(dateColumn, from)
      .lte(dateColumn, to);
    if (table === "tb_expenses") query = query.eq("status", "CONFIRMED");

    const pageEnd = offset + PERIOD_SUMMARY_PAGE_SIZE - 1;
    const result = await query
      .order("id", { ascending: true })
      .range(offset, pageEnd)
      .abortSignal(signal);

    if (result.error || !Array.isArray(result.data) || result.count === null ||
      !Number.isSafeInteger(result.count) || result.count < 0) {
      throw new DashboardRepositoryError(
        result.error ?? new Error("Financial summary page is invalid."),
      );
    }
    const pageCount = result.count;
    if (pageCount > MAX_PERIOD_ROWS_PER_KIND) {
      throw new DashboardRepositoryError(new Error("Financial summary exceeds the permitted row limit."));
    }
    if (total === null) total = pageCount;
    if (pageCount !== total) {
      throw new DashboardRepositoryError(new Error("Financial summary count changed during pagination."));
    }

    const expectedRows = Math.min(PERIOD_SUMMARY_PAGE_SIZE, total - offset);
    if (result.data.length !== expectedRows) {
      throw new DashboardRepositoryError(new Error("Financial summary returned an incomplete page."));
    }
    for (const value of result.data) {
      if (typeof value !== "object" || value === null || Array.isArray(value) ||
        !Object.hasOwn(value, amountColumn)) {
        throw new DashboardRepositoryError(new Error("Financial summary row is invalid."));
      }
      totalCents += amountToCents((value as Record<string, unknown>)[amountColumn]);
    }
    offset += result.data.length;
  } while (total === null || offset < total);

  if (total === null) {
    throw new DashboardRepositoryError(new Error("Financial summary count is unavailable."));
  }
  return { count: total, amount: centsToAmount(totalCents) };
}

export async function readPeriodFinancialSnapshot(
  householdId: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<PeriodFinancialSnapshot> {
  const [expenses, incomes] = await Promise.all([
    readPeriodAmountCollection(
      "tb_expenses", "total_amount", "expense_date", householdId, from, to, signal,
    ),
    readPeriodAmountCollection(
      "tb_incomes", "amount", "income_date", householdId, from, to, signal,
    ),
  ]);
  return {
    expenseCount: expenses.count,
    incomeCount: incomes.count,
    expenseAmount: expenses.amount,
    incomeAmount: incomes.amount,
  };
}

const PERIOD_CATEGORY_PAGE_SIZE = 500;
const MAX_PERIOD_CATEGORY_EXPENSES = 5000;
const MAX_PERIOD_CATEGORY_ITEMS = 50000;
const PERIOD_CATEGORY_ITEM_PARENT_BATCH = 200;
const MAX_PERIOD_CATEGORY_TAXONOMY_ROWS = 5000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PeriodCategoryRelation {
  id: string;
  name: string;
}

interface PeriodCategoryExpenseRow {
  id: string;
  total_amount: string;
  category_id: string | null;
  category: PeriodCategoryRelation | null;
}

interface PeriodCategoryItemRow {
  id: string;
  expense_id: string;
  total_amount: string;
  category_id: string | null;
  category: PeriodCategoryRelation | null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function invalidCategoryRead(message: string, cause?: unknown): never {
  throw new DashboardRepositoryError(cause ?? new Error(message));
}

function readCategoryRelation(value: unknown, categoryId: unknown): PeriodCategoryRelation | null {
  if (categoryId === null) {
    if (value !== null) invalidCategoryRead("Unexpected category relation.");
    return null;
  }
  if (typeof categoryId !== "string" || !UUID_PATTERN.test(categoryId) ||
    !isObjectRecord(value) || !hasExactKeys(value, ["id", "name"]) ||
    value.id !== categoryId || typeof value.name !== "string" || !value.name.trim()) {
    invalidCategoryRead("Invalid category relation.");
  }
  return { id: value.id as string, name: value.name as string };
}

async function readPeriodCategoryExpenses(
  householdId: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<PeriodCategoryExpenseRow[]> {
  const rows: PeriodCategoryExpenseRow[] = [];
  let offset = 0;
  let total: number | null = null;
  const ids = new Set<string>();
  do {
    const result = await getSupabaseAdminClient()
      .from("tb_expenses")
      .select("id,total_amount::text,category_id,category:tb_categories!fk_tb_expenses_category(id,name)", { count: "exact" })
      .eq("household_id", householdId)
      .eq("status", "CONFIRMED")
      .gte("expense_date", from)
      .lte("expense_date", to)
      .order("id", { ascending: true })
      .range(offset, offset + PERIOD_CATEGORY_PAGE_SIZE - 1)
      .abortSignal(signal);
    if (result.error) invalidCategoryRead("Expense page failed.", result.error);
    if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count) || (result.count as number) < 0) {
      invalidCategoryRead("Expense page response is invalid.");
    }
    const pageTotal = result.count as number;
    if (pageTotal > MAX_PERIOD_CATEGORY_EXPENSES) {
      invalidCategoryRead("Expense row limit exceeded.");
    }
    if (total === null) total = pageTotal;
    if (pageTotal !== total) invalidCategoryRead("Expense count changed during pagination.");
    const expected = Math.min(PERIOD_CATEGORY_PAGE_SIZE, total - offset);
    if (result.data.length !== expected) invalidCategoryRead("Expense page is incomplete.");
    for (const raw of result.data) {
      if (!isObjectRecord(raw) || !hasExactKeys(raw, ["id", "total_amount", "category_id", "category"]) ||
        typeof raw.id !== "string" || !UUID_PATTERN.test(raw.id) || ids.has(raw.id.toLowerCase()) ||
        typeof raw.total_amount !== "string" ||
        (raw.category_id !== null && typeof raw.category_id !== "string")) {
        invalidCategoryRead("Expense row is invalid.");
      }
      const category = readCategoryRelation(raw.category, raw.category_id);
      ids.add(raw.id.toLowerCase());
      rows.push({
        id: raw.id,
        total_amount: raw.total_amount,
        category_id: raw.category_id as string | null,
        category,
      });
    }
    offset += result.data.length;
  } while (total === null || offset < total);
  if (total === null || rows.length !== total) invalidCategoryRead("Expense count is unavailable.");
  return rows;
}

async function readPeriodCategoryItems(
  expenses: readonly PeriodCategoryExpenseRow[],
  signal: AbortSignal,
): Promise<{ byExpense: Map<string, PeriodCategoryItemRow[]>; itemCount: number }> {
  const byExpense = new Map<string, PeriodCategoryItemRow[]>();
  const seenIds = new Set<string>();
  const expenseIds = new Set(expenses.map((expense) => expense.id.toLowerCase()));
  let itemCount = 0;
  for (let start = 0; start < expenses.length; start += PERIOD_CATEGORY_ITEM_PARENT_BATCH) {
    const ids = expenses.slice(start, start + PERIOD_CATEGORY_ITEM_PARENT_BATCH).map((expense) => expense.id);
    const allowedIds = new Set(ids.map((id) => id.toLowerCase()));
    let offset = 0;
    let total: number | null = null;
    do {
      const result = await getSupabaseAdminClient()
        .from("tb_expense_items")
        .select("id,expense_id,total_amount::text,category_id,category:tb_categories!fk_tb_expense_items_category(id,name)", { count: "exact" })
        .in("expense_id", ids)
        .order("expense_id", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + PERIOD_CATEGORY_PAGE_SIZE - 1)
        .abortSignal(signal);
      if (result.error) invalidCategoryRead("Expense item page failed.", result.error);
      if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count) || (result.count as number) < 0) {
        invalidCategoryRead("Expense item page response is invalid.");
      }
      const pageTotal = result.count as number;
      if (pageTotal > MAX_PERIOD_CATEGORY_ITEMS ||
        (total === null && itemCount + pageTotal > MAX_PERIOD_CATEGORY_ITEMS)) {
        invalidCategoryRead("Expense item row limit exceeded.");
      }
      if (total === null) {
        total = pageTotal;
        itemCount += pageTotal;
      }
      if (pageTotal !== total) invalidCategoryRead("Expense item count changed during pagination.");
      const expected = Math.min(PERIOD_CATEGORY_PAGE_SIZE, total - offset);
      if (result.data.length !== expected) invalidCategoryRead("Expense item page is incomplete.");
      for (const raw of result.data) {
        if (!isObjectRecord(raw) ||
          !hasExactKeys(raw, ["id", "expense_id", "total_amount", "category_id", "category"]) ||
          typeof raw.id !== "string" || !UUID_PATTERN.test(raw.id) ||
          typeof raw.expense_id !== "string" || !allowedIds.has(raw.expense_id.toLowerCase()) ||
          !expenseIds.has(raw.expense_id.toLowerCase()) ||
          typeof raw.total_amount !== "string" ||
          (raw.category_id !== null && typeof raw.category_id !== "string") ||
          seenIds.has(raw.id.toLowerCase())) {
          invalidCategoryRead("Expense item row is invalid.");
        }
        const category = readCategoryRelation(raw.category, raw.category_id);
        const item: PeriodCategoryItemRow = {
          id: raw.id,
          expense_id: raw.expense_id,
          total_amount: raw.total_amount,
          category_id: raw.category_id as string | null,
          category,
        };
        seenIds.add(item.id.toLowerCase());
        const key = item.expense_id.toLowerCase();
        const existing = byExpense.get(key) ?? [];
        existing.push(item);
        byExpense.set(key, existing);
      }
      offset += result.data.length;
    } while (total === null || offset < total);
    if (total === null || offset !== total) invalidCategoryRead("Expense item count is unavailable.");
  }
  if (seenIds.size !== itemCount) invalidCategoryRead("Expense item result is incomplete.");
  return { byExpense, itemCount };
}

async function readPeriodCategoryTaxonomy(signal: AbortSignal): Promise<DashboardCategoryTaxonomyRow[]> {
  const rows: DashboardCategoryTaxonomyRow[] = [];
  const ids = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  do {
    const result = await getSupabaseAdminClient()
      .from("tb_categories")
      .select("id,name,movement_type,level,parent_id,is_active", { count: "exact" })
      .order("id", { ascending: true })
      .range(offset, offset + PERIOD_CATEGORY_PAGE_SIZE - 1)
      .abortSignal(signal);
    if (result.error) invalidCategoryRead("Category taxonomy page failed.", result.error);
    if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count) || (result.count as number) < 0) {
      invalidCategoryRead("Category taxonomy response is invalid.");
    }
    const pageTotal = result.count as number;
    if (pageTotal > MAX_PERIOD_CATEGORY_TAXONOMY_ROWS) {
      invalidCategoryRead("Category taxonomy row limit exceeded.");
    }
    if (total === null) total = pageTotal;
    if (pageTotal !== total) invalidCategoryRead("Category taxonomy count changed during pagination.");
    const expected = Math.min(PERIOD_CATEGORY_PAGE_SIZE, total - offset);
    if (result.data.length !== expected) invalidCategoryRead("Category taxonomy page is incomplete.");
    for (const raw of result.data) {
      if (!isObjectRecord(raw) ||
        !hasExactKeys(raw, ["id", "name", "movement_type", "level", "parent_id", "is_active"]) ||
        typeof raw.id !== "string" || !UUID_PATTERN.test(raw.id) || ids.has(raw.id.toLowerCase()) ||
        typeof raw.name !== "string" || !raw.name.trim() ||
        (raw.movement_type !== null && raw.movement_type !== "EXPENSE" && raw.movement_type !== "INCOME") ||
        (raw.level !== null && raw.level !== "MACRO" && raw.level !== "MICRO") ||
        (raw.parent_id !== null && (typeof raw.parent_id !== "string" || !UUID_PATTERN.test(raw.parent_id))) ||
        typeof raw.is_active !== "boolean") {
        invalidCategoryRead("Category taxonomy row is invalid.");
      }
      ids.add(raw.id.toLowerCase());
      rows.push({
        id: raw.id,
        name: raw.name,
        movementType: raw.movement_type as string | null,
        level: raw.level as string | null,
        parentId: raw.parent_id as string | null,
        isActive: raw.is_active,
      });
    }
    offset += result.data.length;
  } while (total === null || offset < total);
  if (total === null || rows.length !== total) invalidCategoryRead("Category taxonomy count is unavailable.");
  return rows;
}

export async function readPeriodExpenseCategoryData(
  householdId: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<PeriodExpenseCategoryData> {
  const rawExpenses = await readPeriodCategoryExpenses(householdId, from, to, signal);
  const [itemResult, categories] = await Promise.all([
    readPeriodCategoryItems(rawExpenses, signal),
    readPeriodCategoryTaxonomy(signal),
  ]);
  const expenses: DashboardExpenseRow[] = rawExpenses.map((expense) => ({
    totalAmount: expense.total_amount,
    categoryId: expense.category_id,
    categoryName: expense.category?.name ?? null,
    items: (itemResult.byExpense.get(expense.id.toLowerCase()) ?? []).map((item) => ({
      totalAmount: item.total_amount,
      categoryId: item.category_id,
      categoryName: item.category?.name ?? null,
    })),
  }));
  return { expenses, categories, expenseCount: rawExpenses.length, itemCount: itemResult.itemCount };
}

export async function readPeriodFinancialCategoryData(
  householdId: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<PeriodFinancialCategoryData> {
  const [incomes, categoryData] = await Promise.all([
    readPeriodAmountCollection(
      "tb_incomes", "amount", "income_date", householdId, from, to, signal,
    ),
    readPeriodExpenseCategoryData(householdId, from, to, signal),
  ]);
  return {
    incomeCount: incomes.count,
    incomeAmount: incomes.amount,
    categoryData,
  };
}

export async function listDashboardIncomes(
  householdId: string,
  filters: DashboardFilters,
): Promise<DashboardIncomeRow[]> {
  let query = getSupabaseAdminClient()
    .from("tb_incomes")
    .select("member_id,amount::text")
    .eq("household_id", householdId);

  if (filters.from !== undefined) {
    query = query.gte("income_date", filters.from);
  }
  if (filters.to !== undefined) {
    query = query.lte("income_date", filters.to);
  }

  const { data, error } = await query;
  if (error) throw new DashboardRepositoryError(error);

  return ((data ?? []) as DashboardIncomeDatabaseRow[]).map((income) => ({
    memberId: income.member_id,
    amount: income.amount,
  }));
}

export async function listDashboardExpenses(
  householdId: string,
  filters: DashboardFilters,
): Promise<DashboardExpenseRow[]> {
  let query = getSupabaseAdminClient()
    .from("tb_expenses")
    .select(
      "total_amount::text,category_id,category:tb_categories!fk_tb_expenses_category(id,name),items:tb_expense_items(total_amount::text,category_id,category:tb_categories!fk_tb_expense_items_category(id,name))",
    )
    .eq("household_id", householdId)
    .eq("status", "CONFIRMED");

  if (filters.from !== undefined) {
    query = query.gte("expense_date", filters.from);
  }
  if (filters.to !== undefined) {
    query = query.lte("expense_date", filters.to);
  }

  const { data, error } = await query;
  if (error) throw new DashboardRepositoryError(error);

  return ((data ?? []) as unknown as DashboardExpenseDatabaseRow[]).map(
    (expense) => ({
      totalAmount: expense.total_amount,
      categoryId: expense.category_id,
      categoryName: expense.category?.name ?? null,
      items: (expense.items ?? []).map((item) => ({
        totalAmount: item.total_amount,
        categoryId: item.category_id,
        categoryName: item.category?.name ?? null,
      })),
    }),
  );
}
