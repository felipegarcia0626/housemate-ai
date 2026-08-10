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
