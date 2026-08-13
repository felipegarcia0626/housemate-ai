import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type {
  PendingIncomeProposal,
  PendingIncomeProposalPayload,
  PendingProposal,
  PendingExpenseProposal,
  PendingExpenseProposalPayload,
} from "./agent.types";

type RepositoryErrorKind = "CONFLICT" | "PERSISTENCE";

export class PendingProposalRepositoryError extends Error {
  readonly kind: RepositoryErrorKind;

  constructor(kind: RepositoryErrorKind, message: string) {
    super(message);
    this.name = "PendingProposalRepositoryError";
    this.kind = kind;
  }
}

interface PendingProposalRow {
  id: string;
  household_id: string;
  conversation_key: string;
  operation_type: "CREATE_EXPENSE" | "CREATE_INCOME";
  payload: PendingExpenseProposalPayload | PendingIncomeProposalPayload;
  status: "AWAITING_CONFIRMATION";
  created_at: string;
  updated_at: string;
}

function mapRow(row: PendingProposalRow): PendingProposal {
  if (row.operation_type === "CREATE_INCOME") {
    return {
      id: row.id,
      householdId: row.household_id,
      conversationKey: row.conversation_key,
      operationType: row.operation_type,
      payload: row.payload as PendingIncomeProposalPayload,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies PendingIncomeProposal;
  }
  return {
    id: row.id,
    householdId: row.household_id,
    conversationKey: row.conversation_key,
    operationType: row.operation_type,
    payload: row.payload as PendingExpenseProposalPayload,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies PendingExpenseProposal;
}

function persistenceError(
  operation: string,
  error: unknown,
): PendingProposalRepositoryError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "23505") {
    return new PendingProposalRepositoryError(
      "CONFLICT",
      `Pending proposal conflict during ${operation}.`,
    );
  }
  return new PendingProposalRepositoryError(
    "PERSISTENCE",
    `Pending proposal persistence failed during ${operation}.`,
  );
}

export async function createPendingProposal(input: {
  id: string;
  householdId: string;
  conversationKey: string;
  operationType: "CREATE_EXPENSE" | "CREATE_INCOME";
  payload: PendingExpenseProposalPayload | PendingIncomeProposalPayload;
}): Promise<PendingExpenseProposal> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .insert({
      id: input.id,
      household_id: input.householdId,
      conversation_key: input.conversationKey,
      operation_type: input.operationType,
      payload: input.payload,
      status: "AWAITING_CONFIRMATION",
    })
    .select(
      "id,household_id,conversation_key,operation_type,payload,status,created_at,updated_at",
    )
    .single();

  if (error || !data) throw persistenceError("create", error);
  return mapRow(data as PendingProposalRow) as PendingExpenseProposal;
}

export async function createPendingIncomeProposal(input: {
  id: string;
  householdId: string;
  conversationKey: string;
  payload: PendingIncomeProposalPayload;
}): Promise<PendingIncomeProposal> {
  const proposal = await createPendingProposal({
    ...input,
    operationType: "CREATE_INCOME",
  });
  return proposal as unknown as PendingIncomeProposal;
}

export async function findPendingProposal(
  id: string,
  householdId: string,
  conversationKey: string,
): Promise<PendingExpenseProposal | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .select(
      "id,household_id,conversation_key,operation_type,payload,status,created_at,updated_at",
    )
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .eq("operation_type", "CREATE_EXPENSE")
    .eq("status", "AWAITING_CONFIRMATION")
    .maybeSingle();

  if (error) throw persistenceError("read", error);
  return data
    ? (mapRow(data as PendingProposalRow) as PendingExpenseProposal)
    : null;
}

export async function findPendingIncomeProposal(
  id: string,
  householdId: string,
  conversationKey: string,
): Promise<PendingIncomeProposal | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .select(
      "id,household_id,conversation_key,operation_type,payload,status,created_at,updated_at",
    )
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .eq("operation_type", "CREATE_INCOME")
    .eq("status", "AWAITING_CONFIRMATION")
    .maybeSingle();

  if (error) throw persistenceError("read income", error);
  return data
    ? (mapRow(data as PendingProposalRow) as PendingIncomeProposal)
    : null;
}

export async function findPendingProposalForConversation(
  householdId: string,
  conversationKey: string,
): Promise<PendingProposal | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .select(
      "id,household_id,conversation_key,operation_type,payload,status,created_at,updated_at",
    )
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .eq("status", "AWAITING_CONFIRMATION")
    .maybeSingle();

  if (error) throw persistenceError("read conversation", error);
  return data ? mapRow(data as PendingProposalRow) : null;
}

/**
 * Consumes a proposal atomically. The partial unique index prevents a second
 * active proposal for the same conversation, and this conditional delete
 * ensures that only one concurrent confirmation obtains the payload.
 */
export async function consumePendingProposal(
  id: string,
  householdId: string,
  conversationKey: string,
): Promise<PendingExpenseProposal | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .delete()
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .eq("operation_type", "CREATE_EXPENSE")
    .eq("status", "AWAITING_CONFIRMATION")
    .select(
      "id,household_id,conversation_key,operation_type,payload,status,created_at,updated_at",
    )
    .maybeSingle();

  if (error) throw persistenceError("consume", error);
  return data
    ? (mapRow(data as PendingProposalRow) as PendingExpenseProposal)
    : null;
}

export async function consumePendingIncomeProposal(
  id: string,
  householdId: string,
  conversationKey: string,
): Promise<PendingIncomeProposal | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .delete()
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .eq("operation_type", "CREATE_INCOME")
    .eq("status", "AWAITING_CONFIRMATION")
    .select(
      "id,household_id,conversation_key,operation_type,payload,status,created_at,updated_at",
    )
    .maybeSingle();

  if (error) throw persistenceError("consume income", error);
  return data
    ? (mapRow(data as PendingProposalRow) as PendingIncomeProposal)
    : null;
}

export async function restorePendingProposal(
  proposal: PendingExpenseProposal,
): Promise<void> {
  const { error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .insert({
      id: proposal.id,
      household_id: proposal.householdId,
      conversation_key: proposal.conversationKey,
      operation_type: proposal.operationType,
      payload: proposal.payload,
      status: proposal.status,
      created_at: proposal.createdAt,
      updated_at: proposal.updatedAt,
    });

  if (error) throw persistenceError("restore", error);
}

export async function restorePendingIncomeProposal(
  proposal: PendingIncomeProposal,
): Promise<void> {
  const { error } = await getSupabaseAdminClient()
    .from("tb_pending_proposals")
    .insert({
      id: proposal.id,
      household_id: proposal.householdId,
      conversation_key: proposal.conversationKey,
      operation_type: proposal.operationType,
      payload: proposal.payload,
      status: proposal.status,
      created_at: proposal.createdAt,
      updated_at: proposal.updatedAt,
    });

  if (error) throw persistenceError("restore income", error);
}
