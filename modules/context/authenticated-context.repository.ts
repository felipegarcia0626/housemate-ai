import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export interface ApplicationUserRecord {
  id: string;
  authUserId: string;
}

export interface ActiveMembershipRecord {
  householdId: string;
  memberId: string;
}

export class AuthenticatedContextRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to resolve the authenticated application context.", {
      cause,
    });
    this.name = "AuthenticatedContextRepositoryError";
  }
}

export async function findApplicationUserByAuthUserId(
  authUserId: string,
): Promise<ApplicationUserRecord | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_users")
    .select("id, auth_user_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error) {
    throw new AuthenticatedContextRepositoryError(error);
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    authUserId: data.auth_user_id,
  };
}

export async function findActiveMembershipsByUserId(
  userId: string,
): Promise<ActiveMembershipRecord[]> {
  // tb_household_members currently has no status/active column. Every
  // existing membership row is therefore treated as active in this phase.
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("household_id, id")
    .eq("user_id", userId);

  if (error) {
    throw new AuthenticatedContextRepositoryError(error);
  }

  return (data ?? []).map((membership) => ({
    householdId: membership.household_id,
    memberId: membership.id,
  }));
}
