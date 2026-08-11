import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export class ContextRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to validate the configured context.", { cause });
    this.name = "ContextRepositoryError";
  }
}

export async function householdExists(householdId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_households")
    .select("id")
    .eq("id", householdId)
    .maybeSingle();

  if (error) {
    throw new ContextRepositoryError(error);
  }

  return data !== null;
}

export async function memberBelongsToHousehold(
  householdId: string,
  memberId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id")
    .eq("id", memberId)
    .eq("household_id", householdId)
    .maybeSingle();

  if (error) {
    throw new ContextRepositoryError(error);
  }

  return data !== null;
}
