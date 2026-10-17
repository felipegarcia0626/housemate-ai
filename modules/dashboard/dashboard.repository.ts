import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type {
  DashboardExpenseRow,
  DashboardFilters,
  DashboardIncomeRow,
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
