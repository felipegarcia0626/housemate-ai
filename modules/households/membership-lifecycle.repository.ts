import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export class MembershipLifecycleRepositoryError extends Error { constructor(cause: unknown, readonly code: string | null = null) { super("Unable to process household membership.", { cause }); this.name = "MembershipLifecycleRepositoryError"; } }

async function call(name: string, args: Record<string, unknown>) {
  const { data, error } = await getSupabaseAdminClient().rpc(name, args);
  if (error) throw new MembershipLifecycleRepositoryError(error, error.code ?? null);
  if (!data || typeof data !== "object") throw new MembershipLifecycleRepositoryError("Invalid RPC result");
  return data as Record<string, unknown>;
}
export const transferOwner = (authUserId: string, householdId: string, targetMemberId: string) => call("fn_transfer_household_owner", { p_auth_user_id: authUserId, p_household_id: householdId, p_target_member_id: targetMemberId });
export const removeMember = (authUserId: string, householdId: string, targetMemberId: string) => call("fn_remove_household_member", { p_auth_user_id: authUserId, p_household_id: householdId, p_target_member_id: targetMemberId });
export const leaveHousehold = (authUserId: string, householdId: string) => call("fn_leave_household", { p_auth_user_id: authUserId, p_household_id: householdId });

export async function listMembers(householdId: string) {
  const { data, error } = await getSupabaseAdminClient().from("tb_household_members").select("id,user_id,display_name,role,status").eq("household_id", householdId).order("created_at").order("id");
  if (error) throw new MembershipLifecycleRepositoryError(error);
  return data ?? [];
}
