import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type { AcceptedHouseholdInvitation, CreatedHouseholdInvitation } from "./invitation.types";

export class HouseholdInvitationRepositoryError extends Error {
  readonly code: string | null;
  constructor(cause: unknown, code: string | null = null) {
    super("Unable to process household invitation.", { cause });
    this.name = "HouseholdInvitationRepositoryError";
    this.code = code;
  }
}

function resultObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HouseholdInvitationRepositoryError("Invalid RPC result");
  }
  return data as Record<string, unknown>;
}

export async function createHouseholdInvitation(input: {
  householdId: string;
  inviterMemberId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
}): Promise<CreatedHouseholdInvitation> {
  const { data, error } = await getSupabaseAdminClient().rpc("fn_create_household_invitation", {
    p_household_id: input.householdId,
    p_inviter_member_id: input.inviterMemberId,
    p_invitee_email_normalized: input.email,
    p_token_hash: input.tokenHash,
    p_expires_at: input.expiresAt,
  });
  if (error) throw new HouseholdInvitationRepositoryError(error, error.code ?? null);
  const result = resultObject(data);
  if (result.status !== "PENDING" || typeof result.invitationId !== "string") {
    throw new HouseholdInvitationRepositoryError("Invalid create invitation result");
  }
  return { status: "PENDING", invitationId: result.invitationId };
}

export async function acceptHouseholdInvitation(input: {
  authUserId: string;
  email: string;
  tokenHash: string;
}): Promise<AcceptedHouseholdInvitation> {
  const { data, error } = await getSupabaseAdminClient().rpc("fn_accept_household_invitation", {
    p_auth_user_id: input.authUserId,
    p_email_normalized: input.email,
    p_token_hash: input.tokenHash,
  });
  if (error) throw new HouseholdInvitationRepositoryError(error, error.code ?? null);
  const result = resultObject(data);
  if (result.status !== "ACCEPTED" || typeof result.alreadyAccepted !== "boolean" ||
      typeof result.householdId !== "string" || typeof result.memberId !== "string") {
    throw new HouseholdInvitationRepositoryError("Invalid accept invitation result");
  }
  return result as unknown as AcceptedHouseholdInvitation;
}
