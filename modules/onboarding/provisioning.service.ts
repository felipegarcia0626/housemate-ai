import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export type ProvisioningStatus = "PROVISIONING_COMPLETED" | "ALREADY_PROVISIONED";

export class ProvisioningError extends Error {
  readonly code: "VALIDATION_ERROR" | "PERSISTENCE_ERROR";

  constructor(code: "VALIDATION_ERROR" | "PERSISTENCE_ERROR", message: string) {
    super(message);
    this.name = "ProvisioningError";
    this.code = code;
  }
}

export interface ProvisioningResult {
  status: ProvisioningStatus;
  userId: string;
  householdId: string;
  memberId: string;
}

function validateText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ProvisioningError("VALIDATION_ERROR", `${field} is invalid.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) {
    throw new ProvisioningError("VALIDATION_ERROR", `${field} is invalid.`);
  }
  return normalized;
}

export async function provisionAuthenticatedUser(input: {
  displayName: unknown;
  householdName: unknown;
}): Promise<ProvisioningResult> {
  const displayName = validateText(input.displayName, "displayName");
  const householdName = validateText(input.householdName, "householdName");
  let authUser: { id: string };
  try {
    authUser = await getAuthenticatedAuthUser();
  } catch (error) {
    if (error instanceof SupabaseAuthError) throw error;
    throw new ProvisioningError("PERSISTENCE_ERROR", "Provisioning is unavailable.");
  }

  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_provision_authenticated_user",
    {
      p_auth_user_id: authUser.id,
      p_display_name: displayName,
      p_household_name: householdName,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new ProvisioningError("PERSISTENCE_ERROR", "Provisioning is unavailable.");
  }
  const result = data as Record<string, unknown>;
  if (
    (result.status !== "PROVISIONING_COMPLETED" && result.status !== "ALREADY_PROVISIONED") ||
    typeof result.userId !== "string" ||
    typeof result.householdId !== "string" ||
    typeof result.memberId !== "string"
  ) {
    throw new ProvisioningError("PERSISTENCE_ERROR", "Provisioning is unavailable.");
  }
  return result as unknown as ProvisioningResult;
}
