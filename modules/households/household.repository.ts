import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export interface CreatedHouseholdRecord {
  householdId: string;
  householdName: string;
  memberId: string;
  idempotent: boolean;
}

export class HouseholdRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to create household.", { cause });
    this.name = "HouseholdRepositoryError";
  }
}
export class HouseholdApplicationUserNotFoundError extends Error {
  constructor() { super("Application user not found."); this.name = "HouseholdApplicationUserNotFoundError"; }
}

export async function createHouseholdForAuthenticatedUser(
  authUserId: string,
  householdName: string,
  idempotencyKey: string,
): Promise<CreatedHouseholdRecord> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_create_household_for_authenticated_user",
    { p_auth_user_id: authUserId, p_household_name: householdName, p_idempotency_key: idempotencyKey },
  );
  if (error?.code === "P0002") throw new HouseholdApplicationUserNotFoundError();
  if (error || !data || typeof data !== "object") throw new HouseholdRepositoryError(error);
  const result = data as Record<string, unknown>;
  if (typeof result.householdId !== "string" || typeof result.householdName !== "string" || typeof result.memberId !== "string" || typeof result.idempotent !== "boolean")
    throw new HouseholdRepositoryError("invalid result");
  return result as unknown as CreatedHouseholdRecord;
}
