import { randomUUID } from "node:crypto";
import type { AgentContext } from "./agent.types";
import {
  CategoryDraftRepositoryError,
  type CategoryDraftDeleteResult,
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

async function assertExecutionCurrent(context: AgentContext): Promise<void> {
  await context.whatsappExecution?.assertCurrent();
}

function whatsappLease(context: AgentContext) {
  const execution = context.whatsappExecution;
  return execution
    ? {
        userId: execution.userId,
        leaseId: execution.leaseId,
        epoch: execution.epoch,
      }
    : undefined;
}

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
  await assertExecutionCurrent(context);
  return createCategoryDraftInRepository({
    id: randomUUID(),
    householdId: context.householdId,
    actorMemberId: context.actorMemberId,
    conversationKey: context.conversationKey,
    source: context.source,
    operationType,
    payload,
    whatsappLease: whatsappLease(context),
  });
}

export async function createOperationDraft(
  context: AgentContext,
  payload: AgentOperationDraftPayload,
): Promise<AgentDraft> {
  await assertExecutionCurrent(context);
  return createOperationDraftInRepository({
    id: randomUUID(),
    householdId: context.householdId,
    actorMemberId: context.actorMemberId,
    conversationKey: context.conversationKey,
    source: context.source,
    operationType: null,
    status: "AWAITING_OPERATION",
    payload,
    whatsappLease: whatsappLease(context),
  });
}

export async function createDetailsDraft(
  context: AgentContext,
  operationType: AgentCategoryDraftOperation,
  payload: AgentOperationDraftPayload,
): Promise<AgentDraft> {
  await assertExecutionCurrent(context);
  return createOperationDraftInRepository({
    id: randomUUID(),
    householdId: context.householdId,
    actorMemberId: context.actorMemberId,
    conversationKey: context.conversationKey,
    source: context.source,
    operationType,
    status: "AWAITING_DETAILS",
    payload,
    whatsappLease: whatsappLease(context),
  });
}

export async function getActiveAgentDraft(
  context: AgentContext,
): Promise<AgentDraft | null> {
  await assertExecutionCurrent(context);
  const draft = await findActiveDraftInRepository(
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
  );
  if (!draft) return null;
  if (!isExpired(draft)) return draft;
  await assertExecutionCurrent(context);
  const deleteResult = await deleteAgentDraftInRepository(
    draft.id,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
    draft.updatedAt,
    whatsappLease(context),
  );
  if (deleteResult === "DELETED") return null;

  await assertExecutionCurrent(context);
  const currentDraft = await findActiveDraftInRepository(
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
  );
  return currentDraft && !isExpired(currentDraft) ? currentDraft : null;
}

export async function updateAgentDraft(
  context: AgentContext,
  draft: AgentDraft,
  operationType: AgentCategoryDraftOperation | null,
  status: AgentDraft["status"],
  payload: AgentCategoryDraftPayload,
): Promise<AgentDraft> {
  await assertExecutionCurrent(context);
  return updateAgentDraftInRepository(
    draft.id,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
    operationType,
    status,
    payload,
    draft.updatedAt,
    whatsappLease(context),
  );
}

export async function deleteAgentDraft(
  context: AgentContext,
  draftId: string,
  expectedUpdatedAt: string,
): Promise<CategoryDraftDeleteResult> {
  await assertExecutionCurrent(context);
  return deleteAgentDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
    expectedUpdatedAt,
    whatsappLease(context),
  );
}

export async function getActiveCategoryDraft(
  context: AgentContext,
): Promise<AgentCategoryDraft | null> {
  await assertExecutionCurrent(context);
  const draft = await findDraftInRepository(
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
  );
  if (!draft) return null;
  if (!isExpired(draft)) return draft;
  await assertExecutionCurrent(context);
  const deleteResult = await deleteCategoryDraftInRepository(
    draft.id,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
    draft.updatedAt,
    whatsappLease(context),
  );
  if (deleteResult === "DELETED") return null;

  await assertExecutionCurrent(context);
  const currentDraft = await findDraftInRepository(
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
  );
  return currentDraft && !isExpired(currentDraft) ? currentDraft : null;
}

export async function deleteCategoryDraft(
  context: AgentContext,
  draftId: string,
  expectedUpdatedAt: string,
): Promise<CategoryDraftDeleteResult> {
  await assertExecutionCurrent(context);
  return deleteCategoryDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
    expectedUpdatedAt,
    whatsappLease(context),
  );
}

export async function updateCategoryDraft(
  context: AgentContext,
  draftId: string,
  payload: AgentCategoryDraftPayload,
  expectedUpdatedAt?: string,
): Promise<AgentCategoryDraft> {
  await assertExecutionCurrent(context);
  return updateCategoryDraftInRepository(
    draftId,
    context.householdId,
    context.actorMemberId,
    context.conversationKey,
    context.source,
    payload,
    expectedUpdatedAt,
    whatsappLease(context),
  );
}

export function isCategoryDraftRepositoryError(
  error: unknown,
): error is CategoryDraftRepositoryError {
  return error instanceof CategoryDraftRepositoryError;
}
