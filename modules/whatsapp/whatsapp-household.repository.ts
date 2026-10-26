import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export interface WhatsAppHouseholdContextRecord {
  selectedHouseholdId: string | null;
  selectedMemberId: string | null;
  menuHouseholdIds: string[] | null;
  menuPhoneNumberId: string | null;
  menuExpiresAt: string | null;
}

export interface WhatsAppLease {
  userId: string;
  leaseId: string;
  epoch: number;
}

export type WhatsAppHouseholdTransition =
  | { action: "SET_SELECTION"; householdId: string; memberId: string }
  | { action: "OPEN_MENU"; phoneNumberId: string; householdIds: string[] }
  | { action: "CHOOSE_OPTION"; phoneNumberId: string; optionNumber: number }
  | { action: "CANCEL_MENU" }
  | { action: "CLEAR_SELECTION" };

export interface WhatsAppHouseholdTransitionResult {
  status: string;
  householdId?: string;
  memberId?: string;
}

export class WhatsAppHouseholdRepositoryError extends Error {
  constructor(cause: unknown) {
    super("WhatsApp household context persistence failed.", { cause });
    this.name = "WhatsAppHouseholdRepositoryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistenceError(cause: unknown): never {
  throw new WhatsAppHouseholdRepositoryError(cause);
}

export async function acquireWhatsAppLease(
  userId: string,
  leaseId: string,
): Promise<WhatsAppLease | null> {
  let result;
  try {
    result = await getSupabaseAdminClient().rpc(
      "fn_acquire_whatsapp_context_lease",
      { p_user_id: userId, p_lease_id: leaseId, p_lease_seconds: 120 },
    );
  } catch (error) {
    return persistenceError(error);
  }
  if (result.error) return persistenceError(result.error);
  if (!isRecord(result.data) || typeof result.data.acquired !== "boolean") {
    return persistenceError(new Error("Invalid lease result"));
  }
  if (!result.data.acquired) return null;
  if (typeof result.data.epoch !== "number" || !Number.isSafeInteger(result.data.epoch)) {
    return persistenceError(new Error("Invalid lease epoch"));
  }
  return { userId, leaseId, epoch: result.data.epoch };
}

export async function renewWhatsAppLease(lease: WhatsAppLease): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_renew_whatsapp_context_lease",
    {
      p_user_id: lease.userId,
      p_lease_id: lease.leaseId,
      p_lease_epoch: lease.epoch,
      p_lease_seconds: 120,
    },
  );
  if (error) return persistenceError(error);
  return data === true;
}

export async function assertWhatsAppLeaseCurrent(
  lease: WhatsAppLease,
): Promise<void> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_assert_whatsapp_context_lease",
    {
      p_user_id: lease.userId,
      p_lease_id: lease.leaseId,
      p_lease_epoch: lease.epoch,
    },
  );
  if (error) return persistenceError(error);
  if (data !== true) throw new WhatsAppHouseholdRepositoryError(new Error("Lease is stale"));
}

export async function assertWhatsAppActiveContext(
  lease: WhatsAppLease,
  householdId: string,
  actorMemberId: string,
): Promise<void> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_assert_whatsapp_active_context",
    {
      p_user_id: lease.userId,
      p_lease_id: lease.leaseId,
      p_lease_epoch: lease.epoch,
      p_household_id: householdId,
      p_actor_member_id: actorMemberId,
    },
  );
  if (error) return persistenceError(error);
  if (data !== true) {
    throw new WhatsAppHouseholdRepositoryError(new Error("Household context is stale"));
  }
}

export async function releaseWhatsAppLease(lease: WhatsAppLease): Promise<void> {
  const { error } = await getSupabaseAdminClient().rpc(
    "fn_release_whatsapp_context_lease",
    {
      p_user_id: lease.userId,
      p_lease_id: lease.leaseId,
      p_lease_epoch: lease.epoch,
    },
  );
  if (error) return persistenceError(error);
}

export async function readWhatsAppHouseholdContext(
  userId: string,
): Promise<WhatsAppHouseholdContextRecord> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_whatsapp_user_contexts")
    .select(
      "selected_household_id,selected_member_id,menu_household_ids,menu_phone_number_id,menu_expires_at",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return persistenceError(error);
  if (!data) return persistenceError(new Error("Lease context row is missing"));
  return {
    selectedHouseholdId: data.selected_household_id ?? null,
    selectedMemberId: data.selected_member_id ?? null,
    menuHouseholdIds: Array.isArray(data.menu_household_ids)
      ? data.menu_household_ids
      : null,
    menuPhoneNumberId: data.menu_phone_number_id ?? null,
    menuExpiresAt: data.menu_expires_at ?? null,
  };
}

export async function transitionWhatsAppHouseholdContext(
  lease: WhatsAppLease,
  phoneNumberId: string,
  transition: WhatsAppHouseholdTransition,
): Promise<WhatsAppHouseholdTransitionResult> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_transition_whatsapp_household_context",
    {
      p_user_id: lease.userId,
      p_phone_number_id: phoneNumberId,
      p_lease_id: lease.leaseId,
      p_lease_epoch: lease.epoch,
      p_action: transition.action,
      p_household_id:
        transition.action === "SET_SELECTION" ? transition.householdId : null,
      p_member_id:
        transition.action === "SET_SELECTION" ? transition.memberId : null,
      p_household_ids:
        transition.action === "OPEN_MENU" ? transition.householdIds : null,
      p_option_number:
        transition.action === "CHOOSE_OPTION" ? transition.optionNumber : null,
    },
  );
  if (error) return persistenceError(error);
  if (!isRecord(data) || typeof data.status !== "string") {
    return persistenceError(new Error("Invalid household transition result"));
  }
  return {
    status: data.status,
    ...(typeof data.household_id === "string"
      ? { householdId: data.household_id }
      : {}),
    ...(typeof data.member_id === "string" ? { memberId: data.member_id } : {}),
  };
}
