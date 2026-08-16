import { randomUUID } from "node:crypto";
import type { AgentContext } from "./agent.types";
import {
  CategoryDraftRepositoryError,
  createAgentDraft as createOperationDraftInRepository,
  createCategoryDraft as createCategoryDraftInRepository,
  deleteAgentDraft as deleteAgentDraftInRepository,
  deleteCategoryDraft as deleteCategoryDraftInRepository,
  findActiveAgentDraft as findActiveDraftInRepository,
  findCategoryDraft as findDraftInRepository,
  updateAgentDraft as updateAgentDraftInRepository,
  updateCategoryDraft as updateCategoryDraftInRepository,
} from "./category-draft.repository";
import type {
  AgentDraft,
  AgentCategoryDraft,
  AgentCategoryDraftOperation,
  AgentCategoryDraftPayload,
  AgentOperationDraftPayload,
} from "./category-draft.types";

const CATEGORY_DRAFT_TTL_MS = 30 * 60 * 1000;

function isExpired(draft: AgentDraft): boolean {
  const updatedAt = Date.parse(draft.updatedAt);
  return (
    !Number.isFinite(updatedAt) ||
    Date.now() - updatedAt > CATEGORY_DRAFT_TTL_MS
  );
}

export async function createCategoryDraft(
  context: AgentContext,
  operationType: AgentCategoryDraftOperation,
  payload: AgentCategoryDraftPayload,
): Promise<AgentCategoryDraft> {
  return createCategoryDraftInRepository({
    id: randomUUID(),
    householdId: context.householdId,
    actorMemberId: context.actorMemberId,
    conversationKey: context.conversationKey,
    operationType,
    payload,
  });
}

export async function createOperationDraft(
  context: AgentContext,
  payload: AgentOperationDraftPayload,
): Promise<AgentDraft> {
  return createOperationDraftInRepository({
    id: randomUUID(),
    householdId: context.householdId,
    actorMemberId: context.actorMemberId,
    conversationKey: context.conversationKey,
    operationType: null,
    status: "AWAITING_OPERATION",
    payload,
  });
}

export async function getActiveAgentDraft(
  context: AgentContext,
): Promise<AgentDraft | null> {
  const draft = await findActiveDraftInRepository(
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
  );
  if (!draft) return null;
  if (!isExpired(draft)) return draft;
  await deleteAgentDraftInRepository(
    draft.id,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
  );
  return null;
}

export async function updateAgentDraft(
  context: AgentContext,
  draft: AgentDraft,
  operationType: AgentCategoryDraftOperation | null,
  status: AgentDraft["status"],
  payload: AgentCategoryDraftPayload,
): Promise<AgentDraft> {
  return updateAgentDraftInRepository(
    draft.id,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    operationType,
    status,
    payload,
    draft.updatedAt,
  );
}

export async function deleteAgentDraft(
  context: AgentContext,
  draftId: string,
): Promise<void> {
  await deleteAgentDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
  );
}

export async function getActiveCategoryDraft(
  context: AgentContext,
): Promise<AgentCategoryDraft | null> {
  const draft = await findDraftInRepository(
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
  );
  if (!draft) return null;
  if (!isExpired(draft)) return draft;
  await deleteCategoryDraftInRepository(
    draft.id,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
  );
  return null;
}

export async function deleteCategoryDraft(
  context: AgentContext,
  draftId: string,
): Promise<void> {
  await deleteCategoryDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
  );
}

export async function updateCategoryDraft(
  context: AgentContext,
  draftId: string,
  payload: AgentCategoryDraftPayload,
  expectedUpdatedAt?: string,
): Promise<AgentCategoryDraft> {
  return updateCategoryDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    payload,
    expectedUpdatedAt,
  );
}

export function isCategoryDraftRepositoryError(
  error: unknown,
): error is CategoryDraftRepositoryError {
  return error instanceof CategoryDraftRepositoryError;
}
