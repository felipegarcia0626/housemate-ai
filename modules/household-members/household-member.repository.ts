import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type { HouseholdMember } from "./household-member.types";

interface HouseholdMemberRow {
  id: string;
  display_name: string;
}

export class HouseholdMemberRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to access household members.", { cause });
    this.name = "HouseholdMemberRepositoryError";
  }
}

export async function listHouseholdMembers(
  householdId: string,
): Promise<HouseholdMember[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id,display_name")
    .eq("household_id", householdId);

  if (error) throw new HouseholdMemberRepositoryError(error);

  return ((data ?? []) as HouseholdMemberRow[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
  }));
}
