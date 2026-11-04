import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export interface WhatsAppEventFence {
  eventId: string;
  token: string;
  epoch: number;
}

export class WhatsAppEventRepositoryError extends Error {
  constructor() {
    super("WhatsApp event persistence failed.");
    this.name = "WhatsAppEventRepositoryError";
  }
}

export function eventArguments(fence: WhatsAppEventFence) {
  if (
    !fence ||
    !fence.eventId ||
    !fence.token ||
    !Number.isSafeInteger(fence.epoch) ||
    fence.epoch < 1
  ) {
    throw new WhatsAppEventRepositoryError();
  }
  return {
    p_event_id: fence.eventId,
    p_token: fence.token,
    p_epoch: fence.epoch,
  };
}

const eventStatuses = {
  fn_claim_whatsapp_event: [
    "CLAIMED",
    "BUSY",
    "READY",
    "DUPLICATE",
    "UNCERTAIN",
    "UNKNOWN",
    "HISTORICAL",
    "UNAVAILABLE",
    "CONFLICT",
  ],
  fn_begin_whatsapp_event: ["STARTED", "ALREADY_STARTED"],
  fn_bind_whatsapp_event_context: ["BOUND"],
  fn_finish_whatsapp_event: ["COMPLETED"],
  fn_fail_whatsapp_event: ["COMPLETED", "UNCERTAIN"],
  fn_prepare_whatsapp_delivery: [
    "SEND",
    "BUSY",
    "WAIT",
    "ACCEPTED",
    "UNKNOWN",
    "BLOCKED",
    "EXPIRED",
    "HISTORICAL",
    "CONFLICT",
  ],
  fn_finish_whatsapp_delivery: ["ACCEPTED", "RETRYABLE", "UNKNOWN"],
  fn_complete_whatsapp_link_event: [
    "READY",
    "DUPLICATE",
    "CONFLICT",
    "HISTORICAL",
  ],
};

export async function whatsappEventRpc(
  name: keyof typeof eventStatuses,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseAdminClient().rpc(name, args);
  if (
    error ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.status !== "string" ||
    !eventStatuses[name].includes(data.status)
  ) {
    throw new WhatsAppEventRepositoryError();
  }
  return data as Record<string, unknown>;
}

export async function assertWhatsAppEvent(
  fence: WhatsAppEventFence,
): Promise<void> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_assert_whatsapp_event",
    eventArguments(fence),
  );
  if (error || data !== true) throw new WhatsAppEventRepositoryError();
}

export async function renewWhatsAppEvent(
  fence: WhatsAppEventFence,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient().rpc(
    "fn_renew_whatsapp_event",
    eventArguments(fence),
  );
  if (error) throw new WhatsAppEventRepositoryError();
  return data === true;
}
