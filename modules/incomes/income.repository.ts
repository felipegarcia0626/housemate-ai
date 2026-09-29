import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import {
  getAvailableCategoryIds,
  listHierarchicalCategories,
} from "@/modules/categories/category.repository";

import type {
  Income,
  IncomeCreateInput,
  IncomeListFilters,
  IncomeUpdateInput,
} from "./income.types";

type DatabaseNumeric = number | string;
const INCOME_SUMMARY_BATCH_SIZE = 500;

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

export interface IncomeDeletePersistenceInput {
  householdId: string;
  incomeId: string;
}

export interface IncomeListRepositoryResult {
  incomes: Income[];
  allMatchingAmounts: DatabaseNumeric[];
  total: number;
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
  try {
    const availableIds = await getAvailableCategoryIds(
      [categoryId],
      "INCOME",
    );
    return availableIds.has(categoryId.toLowerCase());
  } catch (error) {
    throw new IncomeRepositoryError("TECHNICAL", error);
  }
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

export async function findIncomeById(
  householdId: string,
  incomeId: string,
): Promise<Income | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_incomes")
    .select(
      "id,household_id,created_by,member_id,amount,income_date,description,category_id,created_at,updated_at",
    )
    .eq("id", incomeId)
    .eq("household_id", householdId)
    .maybeSingle();

  if (error) {
    throw new IncomeRepositoryError(
      getIncomePersistenceErrorKind(error),
      error,
    );
  }

  return data ? mapIncome(data as IncomeRow) : null;
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

export async function deleteIncome(
  input: IncomeDeletePersistenceInput,
): Promise<string> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_incomes")
    .delete()
    .eq("id", input.incomeId)
    .eq("household_id", input.householdId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new IncomeRepositoryError(
      getIncomePersistenceErrorKind(error),
      error,
    );
  }

  if (data === null || data.id !== input.incomeId) {
    throw new IncomeRepositoryError(
      "NOT_FOUND",
      new Error("Income was not found in the current household."),
    );
  }

  return data.id;
}

function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function getIncomeMicroCategoryIdsForMacro(
  macroId: string,
): Promise<string[]> {
  const categories = await listHierarchicalCategories("INCOME");
  return categories
    .filter((category) => category.macroId.toLowerCase() === macroId.toLowerCase())
    .map((category) => category.id);
}

export async function listIncomes(
  householdId: string,
  filters: IncomeListFilters,
): Promise<IncomeListRepositoryResult> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const sortBy = filters.sortBy ?? "incomeDate";
  const sortOrder = filters.sortOrder ?? "desc";
  const sortColumn =
    sortBy === "amount"
      ? "amount"
      : sortBy === "description"
        ? "description"
        : "income_date";
  const ascending = sortOrder === "asc";
  const macroCategoryIds =
    filters.macroId === undefined
      ? undefined
      : await getIncomeMicroCategoryIdsForMacro(filters.macroId);
  if (filters.categoryId !== undefined) {
    const availableCategoryIds = await getAvailableCategoryIds(
      [filters.categoryId],
      "INCOME",
    );
    if (!availableCategoryIds.has(filters.categoryId.toLowerCase())) {
      return { incomes: [], allMatchingAmounts: [], total: 0 };
    }
  }

  if (macroCategoryIds !== undefined && macroCategoryIds.length === 0) {
    return { incomes: [], allMatchingAmounts: [], total: 0 };
  }

  const buildQuery = (columns: string) => {
    let query = getSupabaseAdminClient()
      .from("tb_incomes")
      .select(columns, { count: "exact" })
      .eq("household_id", householdId);

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

    if (macroCategoryIds !== undefined) {
      query = query.in("category_id", macroCategoryIds);
    }

    if (filters.search !== undefined) {
      query = query.ilike(
        "description",
        `%${escapeIlikePattern(filters.search)}%`,
      );
    }

    if (filters.minAmount !== undefined) {
      query = query.gte("amount", filters.minAmount);
    }

    if (filters.maxAmount !== undefined) {
      query = query.lte("amount", filters.maxAmount);
    }

    return query;
  };

  const pageQuery = buildQuery(
    "id,household_id,created_by,member_id,amount,income_date,description,category_id,created_at,updated_at",
  )
    .order(sortColumn, { ascending })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  const pageResult = await pageQuery;

  if (pageResult.error) {
    throw new IncomeRepositoryError("TECHNICAL", pageResult.error);
  }

  if (
    pageResult.count === null ||
    !Number.isInteger(pageResult.count) ||
    pageResult.count < 0
  ) {
    throw new IncomeRepositoryError(
      "TECHNICAL",
      new Error("Income collection count is unavailable."),
    );
  }

  const allMatchingAmounts: DatabaseNumeric[] = [];
  for (
    let from = 0;
    from < pageResult.count;
    from += INCOME_SUMMARY_BATCH_SIZE
  ) {
    const to = Math.min(
      from + INCOME_SUMMARY_BATCH_SIZE,
      pageResult.count,
    ) - 1;
    const summaryResult = await buildQuery("amount")
      .order("id", { ascending: true })
      .range(from, to);

    if (summaryResult.error) {
      throw new IncomeRepositoryError("TECHNICAL", summaryResult.error);
    }

    const rows = (summaryResult.data ?? []) as unknown as Array<{
      amount: DatabaseNumeric;
    }>;
    const expectedBatchCount = to - from + 1;
    if (rows.length !== expectedBatchCount) {
      throw new IncomeRepositoryError(
        "TECHNICAL",
        new Error("Income summary returned an incomplete batch."),
      );
    }

    allMatchingAmounts.push(...rows.map((row) => row.amount));
  }

  if (allMatchingAmounts.length !== pageResult.count) {
    throw new IncomeRepositoryError(
      "TECHNICAL",
      new Error("Income summary returned an incomplete result."),
    );
  }

  return {
    incomes: ((pageResult.data ?? []) as unknown as IncomeRow[]).map(mapIncome),
    allMatchingAmounts,
    total: pageResult.count,
  };
}
