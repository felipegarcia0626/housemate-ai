import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type {
  AgentCategoryDraft,
  AgentCategoryDraftOperation,
  AgentCategoryDraftPayload,
} from "./category-draft.types";

type DraftRow = {
  id: string;
  household_id: string;
  actor_member_id: string;
  conversation_key: string;
  operation_type: AgentCategoryDraftOperation;
  payload: AgentCategoryDraftPayload;
  status: "AWAITING_CATEGORY";
  created_at: string;
  updated_at: string;
};

export class CategoryDraftRepositoryError extends Error {
  constructor() {
    super("Unable to access the category draft.");
    this.name = "CategoryDraftRepositoryError";
  }
}

const columns =
  "id,household_id,actor_member_id,conversation_key,operation_type,payload,status,created_at,updated_at";

function mapRow(row: DraftRow): AgentCategoryDraft {
  return {
    id: row.id,
    householdId: row.household_id,
    actorMemberId: row.actor_member_id,
    conversationKey: row.conversation_key,
    operationType: row.operation_type,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function handleError(error: unknown): never {
  throw new CategoryDraftRepositoryError();
}

export async function createCategoryDraft(input: {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  operationType: AgentCategoryDraftOperation;
  payload: AgentCategoryDraftPayload;
}): Promise<AgentCategoryDraft> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .insert({
      id: input.id,
      household_id: input.householdId,
      actor_member_id: input.actorMemberId,
      conversation_key: input.conversationKey,
      operation_type: input.operationType,
      payload: input.payload,
      status: "AWAITING_CATEGORY",
    })
    .select(columns)
    .single();

  if (error || !data) handleError(error);
  return mapRow(data as DraftRow);
}

export async function findCategoryDraft(
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
): Promise<AgentCategoryDraft | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .select(columns)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("status", "AWAITING_CATEGORY")
    .maybeSingle();

  if (error) handleError(error);
  return data ? mapRow(data as DraftRow) : null;
}

export async function updateCategoryDraft(
  id: string,
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  payload: AgentCategoryDraftPayload,
): Promise<AgentCategoryDraft> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .update({ payload })
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("status", "AWAITING_CATEGORY")
    .select(columns)
    .single();

  if (error || !data) handleError(error);
  return mapRow(data as DraftRow);
}

export async function deleteCategoryDraft(
  id: string,
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
): Promise<void> {
  const { error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .delete()
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("status", "AWAITING_CATEGORY");

  if (error) handleError(error);
}
