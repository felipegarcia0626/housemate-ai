import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type {
  Income,
  IncomeCreateInput,
  IncomeListFilters,
  IncomeUpdateInput,
} from "./income.types";

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

export type IncomeRepositoryErrorKind = "INTEGRITY" | "NOT_FOUND" | "TECHNICAL";

export class IncomeRepositoryError extends Error {
  readonly kind: IncomeRepositoryErrorKind;

  constructor(kind: IncomeRepositoryErrorKind, cause: unknown) {
    super("Unable to access Incomes.", { cause });
    this.name = "IncomeRepositoryError";
    this.kind = kind;
  }
}

export interface IncomeCreatePersistenceInput extends IncomeCreateInput {
  householdId: string;
  createdBy: string;
  categoryId: string | null;
}

export interface IncomeUpdatePersistenceInput extends IncomeUpdateInput {
  householdId: string;
  incomeId: string;
}

function getIncomePersistenceErrorKind(
  error: unknown,
): IncomeRepositoryErrorKind {
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
    throw new IncomeRepositoryError("TECHNICAL", error);
  }

  return data !== null;
}

export async function isIncomeCategoryAvailable(
  categoryId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id")
    .eq("id", categoryId)
    .maybeSingle();

  if (error) {
    throw new IncomeRepositoryError("TECHNICAL", error);
  }

  return data !== null;
}

export async function createIncome(
  input: IncomeCreatePersistenceInput,
): Promise<Income> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_incomes")
    .insert({
      household_id: input.householdId,
      created_by: input.createdBy,
      member_id: input.memberId,
      amount: input.amount,
      income_date: input.incomeDate,
      description: input.description,
      category_id: input.categoryId,
    })
    .select(
      "id,household_id,created_by,member_id,amount,income_date,description,category_id,created_at,updated_at",
    )
    .single();

  if (error) {
    throw new IncomeRepositoryError(
      getIncomePersistenceErrorKind(error),
      error,
    );
  }

  if (data === null) {
    throw new IncomeRepositoryError(
      "TECHNICAL",
      new Error("Income insert returned no representation."),
    );
  }

  return mapIncome(data as IncomeRow);
}

export async function updateIncome(
  input: IncomeUpdatePersistenceInput,
): Promise<Income> {
  const payload: Record<string, string | number | null> = {};

  if (input.memberId !== undefined) {
    payload.member_id = input.memberId;
  }
  if (input.amount !== undefined) {
    payload.amount = input.amount;
  }
  if (input.incomeDate !== undefined) {
    payload.income_date = input.incomeDate;
  }
  if (input.description !== undefined) {
    payload.description = input.description;
  }
  if (input.categoryId !== undefined) {
    payload.category_id = input.categoryId;
  }

  const { data, error } = await getSupabaseAdminClient()
    .from("tb_incomes")
    .update(payload)
    .eq("id", input.incomeId)
    .eq("household_id", input.householdId)
    .select(
      "id,household_id,created_by,member_id,amount,income_date,description,category_id,created_at,updated_at",
    )
    .maybeSingle();

  if (error) {
    throw new IncomeRepositoryError(
      getIncomePersistenceErrorKind(error),
      error,
    );
  }

  if (data === null) {
    throw new IncomeRepositoryError(
      "NOT_FOUND",
      new Error("Income was not found in the current household."),
    );
  }

  return mapIncome(data as IncomeRow);
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
    throw new IncomeRepositoryError("TECHNICAL", error);
  }

  return ((data ?? []) as IncomeRow[]).map(mapIncome);
}
