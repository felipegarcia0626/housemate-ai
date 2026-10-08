import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type { HouseholdNotificationEvent, NotificationSourceEntityType, NotificationType } from "./notification.types";

export type NotificationRecord = {
  id: string;
  recipientUserId: string;
  householdId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  sourceEntityType: NotificationSourceEntityType | null;
  sourceEntityId: string | null;
  deduplicationKey: string | null;
  createdAt: string;
  readAt: string | null;
  actionState?: "PENDING" | "ACCEPTED" | "EXPIRED" | "UNAVAILABLE";
};

export type NotificationCursor = { createdAt: string; id: string };

export type NotificationCreateInput = HouseholdNotificationEvent & {
  recipientUserId: string;
  title: string;
  body: string;
};

export type NotificationRepositoryErrorKind =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTEGRITY"
  | "TECHNICAL";

export class NotificationRepositoryError extends Error {
  readonly kind: NotificationRepositoryErrorKind;
  readonly code: string | null;

  constructor(kind: NotificationRepositoryErrorKind, cause: unknown, code: string | null = null) {
    super("Unable to access notifications.", { cause });
    this.name = "NotificationRepositoryError";
    this.kind = kind;
    this.code = code;
  }
}

const columns =
  "id,recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key,created_at,read_at";

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function mapError(error: unknown): NotificationRepositoryError {
  const code = errorCode(error);
  if (code === "23505") return new NotificationRepositoryError("CONFLICT", error, code);
  if (["22P02", "23503", "23514"].includes(code ?? "")) {
    return new NotificationRepositoryError("INTEGRITY", error, code);
  }
  return new NotificationRepositoryError("TECHNICAL", error, code);
}

function mapRow(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    recipientUserId: String(row.recipient_user_id),
    householdId: String(row.household_id),
    type: row.type as NotificationType,
    title: String(row.title),
    body: String(row.body),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    sourceEntityType: (row.source_entity_type as NotificationRecord["sourceEntityType"]) ?? null,
    sourceEntityId: (row.source_entity_id as string | null) ?? null,
    deduplicationKey: (row.deduplication_key as string | null) ?? null,
    createdAt: String(row.created_at),
    readAt: (row.read_at as string | null) ?? null,
  };
}

export async function listNotifications(input: {
  recipientUserId: string;
  householdId?: string;
  limit: number;
  cursor?: NotificationCursor;
  unreadOnly?: boolean;
}): Promise<{ notifications: NotificationRecord[]; nextCursor: NotificationCursor | null }> {
  let query = getSupabaseAdminClient()
    .from("tb_notifications")
    .select(columns)
    .eq("recipient_user_id", input.recipientUserId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(input.limit + 1);

  if (input.householdId) query = query.eq("household_id", input.householdId);
  if (input.unreadOnly) query = query.is("read_at", null);
  if (input.cursor) {
    const timestamp = input.cursor.createdAt.replaceAll(",", "");
    const id = input.cursor.id.replaceAll(",", "");
    query = query.or(`created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`);
  }

  const { data, error } = await query;
  if (error) throw mapError(error);
  const rows = (data ?? []) as Record<string, unknown>[];
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit).map(mapRow);
  const last = page.at(-1);
  return {
    notifications: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export async function countUnreadNotifications(input: { recipientUserId: string; householdId?: string }): Promise<number> {
  let query = getSupabaseAdminClient()
    .from("tb_notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_user_id", input.recipientUserId)
    .is("read_at", null);
  if (input.householdId) query = query.eq("household_id", input.householdId);
  const { count, error } = await query;
  if (error) throw mapError(error);
  return count ?? 0;
}

export async function getInvitationActionStates(invitationIds: string[], currentUserId: string): Promise<Map<string, NotificationRecord["actionState"]>> {
  const states = new Map<string, NotificationRecord["actionState"]>();
  if (invitationIds.length === 0) return states;
  const { data, error } = await getSupabaseAdminClient().from("tb_household_invitations").select("id,status,accepted_user_id,expires_at").in("id", invitationIds);
  if (error) throw mapError(error);
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = String(row.id);
    const status = String(row.status);
    if (status === "ACCEPTED") states.set(id, row.accepted_user_id === currentUserId ? "ACCEPTED" : "UNAVAILABLE");
    else if (status === "PENDING") states.set(id, new Date(String(row.expires_at)).getTime() <= Date.now() ? "EXPIRED" : "PENDING");
    else states.set(id, "UNAVAILABLE");
  }
  for (const id of invitationIds) if (!states.has(id)) states.set(id, "UNAVAILABLE");
  return states;
}

export async function markNotificationAsRead(input: {
  notificationId: string;
  recipientUserId: string;
}): Promise<NotificationRecord> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("tb_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", input.notificationId)
    .eq("recipient_user_id", input.recipientUserId)
    .is("read_at", null)
    .select(columns)
    .maybeSingle();
  if (error) throw mapError(error);
  if (data) return mapRow(data as Record<string, unknown>);

  const existing = await client
    .from("tb_notifications")
    .select(columns)
    .eq("id", input.notificationId)
    .eq("recipient_user_id", input.recipientUserId)
    .maybeSingle();
  if (existing.error) throw mapError(existing.error);
  if (!existing.data) throw new NotificationRepositoryError("NOT_FOUND", null);
  return mapRow(existing.data as Record<string, unknown>);
}

export async function markAllNotificationsAsRead(input: { recipientUserId: string }): Promise<number> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_user_id", input.recipientUserId)
    .is("read_at", null)
    .select("id");
  if (error) throw mapError(error);
  return data?.length ?? 0;
}

export async function createNotification(input: NotificationCreateInput): Promise<{
  notification: NotificationRecord;
  created: boolean;
}> {
  const client = getSupabaseAdminClient();
  const payload = {
    recipient_user_id: input.recipientUserId,
    household_id: input.householdId,
    type: input.type,
    title: input.title,
    body: input.body,
    metadata: input.metadata,
    source_entity_type: input.sourceEntityType,
    source_entity_id: input.sourceEntityId,
    deduplication_key: input.deduplicationKey,
  };
  const result = await client.from("tb_notifications").insert(payload).select(columns).single();
  if (!result.error && result.data) {
    return { notification: mapRow(result.data as Record<string, unknown>), created: true };
  }
  const code = errorCode(result.error);
  if (code !== "23505" || input.deduplicationKey === null) throw mapError(result.error);

  const existing = await client
    .from("tb_notifications")
    .select(columns)
    .eq("recipient_user_id", input.recipientUserId)
    .eq("deduplication_key", input.deduplicationKey)
    .single();
  if (existing.error) throw mapError(existing.error);
  return { notification: mapRow(existing.data as Record<string, unknown>), created: false };
}
