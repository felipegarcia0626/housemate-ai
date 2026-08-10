import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type { Income, IncomeListFilters } from "./income.types";

type DatabaseNumeric = number | string;

interface IncomeRow {
  id: string;
  household_id: string;
  created_by: string;
  member_id: string;
  amount: DatabaseNumeric;
  income_date: string;
  description: string;
  category_id: string | null;
  created_at: string;
  updated_at: string;
}

export class IncomeRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to read Incomes.", { cause });
    this.name = "IncomeRepositoryError";
  }
}

function mapIncome(row: IncomeRow): Income {
  return {
    id: row.id,
    householdId: row.household_id,
    createdBy: row.created_by,
    memberId: row.member_id,
    amount: typeof row.amount === "number" ? row.amount : Number(row.amount),
    incomeDate: row.income_date,
    description: row.description,
    categoryId: row.category_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function isIncomeMemberInHousehold(
  householdId: string,
  memberId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId)
    .eq("id", memberId)
    .maybeSingle();

  if (error) {
    throw new IncomeRepositoryError(error);
  }

  return data !== null;
}

export async function listIncomes(
  householdId: string,
  filters: IncomeListFilters,
): Promise<Income[]> {
  let query = getSupabaseAdminClient()
    .from("tb_incomes")
    .select(
      "id,household_id,created_by,member_id,amount,income_date,description,category_id,created_at,updated_at",
    )
    .eq("household_id", householdId)
    .order("income_date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (filters.from !== undefined) {
    query = query.gte("income_date", filters.from);
  }

  if (filters.to !== undefined) {
    query = query.lte("income_date", filters.to);
  }

  if (filters.memberId !== undefined) {
    query = query.eq("member_id", filters.memberId);
  }

  if (filters.categoryId !== undefined) {
    query = query.eq("category_id", filters.categoryId);
  }

  const { data, error } = await query;

  if (error) {
    throw new IncomeRepositoryError(error);
  }

  return ((data ?? []) as IncomeRow[]).map(mapIncome);
}
