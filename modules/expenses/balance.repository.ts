import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type { BalanceExpenseRecord } from "./balance.types";

type DatabaseNumeric = number | string;

interface BalanceDistributionRow {
  household_member_id: string;
  amount: DatabaseNumeric;
}

interface BalanceExpenseRow {
  paid_by: string;
  total_amount: DatabaseNumeric;
  tb_expense_distributions: BalanceDistributionRow[] | null;
}

export class BalanceRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to load Balance data.", { cause });
    this.name = "BalanceRepositoryError";
  }
}

export async function listBalanceHouseholdMembers(
  householdId: string,
): Promise<string[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId);

  if (error) throw new BalanceRepositoryError(error);
  return (data ?? []).map((row) => row.id as string);
}

export async function listConfirmedBalanceExpenses(
  householdId: string,
): Promise<BalanceExpenseRecord[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_expenses")
    .select(
      "paid_by,total_amount,tb_expense_distributions(household_member_id,amount)",
    )
    .eq("household_id", householdId)
    .eq("status", "CONFIRMED");

  if (error) throw new BalanceRepositoryError(error);

  return ((data ?? []) as BalanceExpenseRow[]).map((expense) => ({
    paidByMemberId: expense.paid_by,
    totalAmount: expense.total_amount,
    distributions: (expense.tb_expense_distributions ?? []).map(
      (distribution) => ({
        memberId: distribution.household_member_id,
        amount: distribution.amount,
      }),
    ),
  }));
}
