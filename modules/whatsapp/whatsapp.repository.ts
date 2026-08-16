import { getSupabaseAdminClient } from "@/infrastructure/database/client";

type MemberLookupResult = {
  data: { id: string } | null;
  error: unknown;
};

export class WhatsAppRepositoryError extends Error {
  readonly duplicate: boolean;

  constructor(cause: unknown, duplicate = false) {
    super("WhatsApp persistence failed.", { cause });
    this.name = "WhatsAppRepositoryError";
    this.duplicate = duplicate;
  }
}

function isDuplicateError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; status?: unknown };
  return value.code === "23505" || value.status === 409;
}

export async function findWhatsAppMember(
  householdId: string,
  externalIdentifier: string,
): Promise<string | null> {
  let client: ReturnType<typeof getSupabaseAdminClient>;
  try {
    client = getSupabaseAdminClient();
  } catch (error) {
    throw new WhatsAppRepositoryError(error);
  }

  let userResult: MemberLookupResult;
  try {
    userResult = await client
      .from("tb_users")
      .select("id")
      .eq("external_identifier", externalIdentifier)
      .maybeSingle();
  } catch (error) {
    throw new WhatsAppRepositoryError(error);
  }
  if (userResult.error) {
    throw new WhatsAppRepositoryError(userResult.error);
  }
  if (!userResult.data) {
    return null;
  }

  let memberResult: MemberLookupResult;
  try {
    memberResult = await client
      .from("tb_household_members")
      .select("id")
      .eq("household_id", householdId)
      .eq("user_id", userResult.data.id)
      .maybeSingle();
  } catch (error) {
    throw new WhatsAppRepositoryError(error);
  }
  if (memberResult.error) {
    throw new WhatsAppRepositoryError(memberResult.error);
  }
  if (!memberResult.data) {
    return null;
  }
  return memberResult.data?.id ?? null;
}

export async function reserveWhatsAppEvent(
  externalEventId: string,
): Promise<boolean> {
  const { error } = await getSupabaseAdminClient()
    .from("tb_processed_whatsapp_events")
    .insert({ external_event_id: externalEventId });

  if (!error) return true;
  if (isDuplicateError(error)) return false;
  throw new WhatsAppRepositoryError(error);
}
