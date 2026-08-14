import { randomUUID } from "node:crypto";
import type { AgentContext } from "./agent.types";
import {
  CategoryDraftRepositoryError,
  createCategoryDraft as createDraftInRepository,
  deleteCategoryDraft as deleteDraftInRepository,
  findCategoryDraft as findDraftInRepository,
  updateCategoryDraft as updateDraftInRepository,
} from "./category-draft.repository";
import type {
  AgentCategoryDraft,
  AgentCategoryDraftOperation,
  AgentCategoryDraftPayload,
} from "./category-draft.types";

const CATEGORY_DRAFT_TTL_MS = 30 * 60 * 1000;

function isExpired(draft: AgentCategoryDraft): boolean {
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
  return createDraftInRepository({
    id: randomUUID(),
    householdId: context.householdId,
    actorMemberId: context.actorMemberId,
    conversationKey: context.conversationKey,
    operationType,
    payload,
  });
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
  await deleteDraftInRepository(
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
  await deleteDraftInRepository(
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
): Promise<AgentCategoryDraft> {
  return updateDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    payload,
  );
}

export function isCategoryDraftRepositoryError(
  error: unknown,
): error is CategoryDraftRepositoryError {
  return error instanceof CategoryDraftRepositoryError;
}
