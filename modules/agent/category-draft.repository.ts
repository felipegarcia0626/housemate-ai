import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type {
  AgentDraft,
  AgentCategoryDraft,
  AgentCategoryDraftOperation,
  AgentCategoryDraftStatus,
  AgentCategoryDraftPayload,
} from "./category-draft.types";
import type { ExpenseSource } from "@/modules/expenses/expense.types";

type DraftRow = {
  id: string;
  household_id: string;
  actor_member_id: string;
  conversation_key: string;
  source: ExpenseSource;
  operation_type: AgentCategoryDraftOperation | null;
  payload: AgentCategoryDraftPayload;
  status: AgentCategoryDraftStatus;
  created_at: string;
  updated_at: string;
};

export type CategoryDraftDeleteResult =
  | "DELETED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND";

export class CategoryDraftRepositoryError extends Error {
  constructor(cause?: unknown) {
    super("Unable to access the category draft.", { cause });
    this.name = "CategoryDraftRepositoryError";
  }
}

const columns =
  "id,household_id,actor_member_id,conversation_key,source,operation_type,payload,status,created_at,updated_at";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isSource(value: unknown): boolean {
  return value === "WEB" || value === "WHATSAPP" || value === "RECEIPT";
}

function isOperation(value: unknown): value is AgentCategoryDraftOperation {
  return value === "CREATE_EXPENSE" || value === "CREATE_INCOME";
}

function isStatus(value: unknown): value is AgentCategoryDraftStatus {
  return (
    value === "AWAITING_OPERATION" ||
    value === "AWAITING_DETAILS" ||
    value === "AWAITING_CATEGORY"
  );
}

function isOperationPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "amount",
    "date",
    "merchant",
    "description",
    "paidBySelf",
    "paidByMemberName",
    "categoryName",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (
    isNullableString(value.amount) &&
    isNullableString(value.date) &&
    isNullableString(value.merchant) &&
    isNullableString(value.description) &&
    (value.paidBySelf === null || typeof value.paidBySelf === "boolean") &&
    isNullableString(value.paidByMemberName) &&
    isNullableString(value.categoryName)
  );
}

function isExpenseSplit(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      new Set(["householdMemberId", "percentage"]).has(key),
    ) &&
    isString(value.householdMemberId) &&
    isFiniteNumber(value.percentage)
  );
}

function isExpenseItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      new Set(["name", "quantity", "unitPrice", "totalAmount", "categoryId"]).has(
        key,
      ),
    ) &&
    isString(value.name) &&
    isFiniteNumber(value.totalAmount) &&
    (!('quantity' in value) || isNullableFiniteNumber(value.quantity)) &&
    (!('unitPrice' in value) || isNullableFiniteNumber(value.unitPrice)) &&
    (!('categoryId' in value) || isNullableString(value.categoryId))
  );
}

function isExpenseProposalInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "paidByMemberId",
    "categoryId",
    "receiptId",
    "merchant",
    "totalAmount",
    "expenseDate",
    "description",
    "items",
    "splits",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    !isString(value.paidByMemberId) ||
    !isFiniteNumber(value.totalAmount) ||
    !isString(value.expenseDate)
  ) {
    return false;
  }
  if (
    "splits" in value &&
    (!Array.isArray(value.splits) ||
      !value.splits.every(isExpenseSplit))
  ) {
    return false;
  }
  if (
    ("categoryId" in value && !isNullableString(value.categoryId)) ||
    ("receiptId" in value && !isNullableString(value.receiptId)) ||
    ("merchant" in value && !isNullableString(value.merchant)) ||
    ("description" in value && !isNullableString(value.description))
  ) {
    return false;
  }
  return !(
    "items" in value &&
    (!Array.isArray(value.items) ||
      !value.items.every(isExpenseItem))
  );
}

function isIncomeCreateInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    !Object.keys(value).some(
      (key) =>
        !new Set(["memberId", "amount", "incomeDate", "description", "categoryId"]).has(
          key,
        ),
    ) &&
    (!('memberId' in value) || isString(value.memberId)) &&
    isFiniteNumber(value.amount) &&
    isString(value.incomeDate) &&
    isString(value.description) &&
    (!('categoryId' in value) || isNullableString(value.categoryId))
  );
}

function isCategoryPayload(value: unknown, operationType: AgentCategoryDraftOperation): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "actorMemberId",
    "source",
    "selectedMacroId",
    "expense",
    "income",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    ("actorMemberId" in value && !isString(value.actorMemberId)) ||
    ("source" in value && !isSource(value.source)) ||
    ("selectedMacroId" in value && !isNullableString(value.selectedMacroId))
  ) {
    return false;
  }
  return operationType === "CREATE_EXPENSE"
    ? isExpenseProposalInput(value.expense) && !("income" in value)
    : isIncomeCreateInput(value.income) && !("expense" in value);
}

function isValidDraftRow(value: unknown): value is DraftRow {
  if (!isRecord(value)) return false;
  if (
    !isString(value.id) ||
    !isString(value.household_id) ||
    !isString(value.actor_member_id) ||
    !isString(value.conversation_key) ||
    !isSource(value.source) ||
    !isStatus(value.status) ||
    !isString(value.created_at) ||
    !isString(value.updated_at)
  ) {
    return false;
  }
  const operationType = value.operation_type;
  if (value.status === "AWAITING_OPERATION") {
    return operationType === null && isOperationPayload(value.payload);
  }
  if (!isOperation(operationType)) return false;
  return value.status === "AWAITING_DETAILS"
    ? isOperationPayload(value.payload)
    : isCategoryPayload(value.payload, operationType);
}

function mapRow(row: DraftRow): AgentDraft {
  return {
    id: row.id,
    householdId: row.household_id,
    actorMemberId: row.actor_member_id,
    conversationKey: row.conversation_key,
    source: row.source,
    operationType: row.operation_type,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as AgentDraft;
}

function parseDraftRow(value: unknown): AgentDraft {
  if (!isValidDraftRow(value)) handleError(value);
  return mapRow(value);
}

function handleError(error: unknown): never {
  throw new CategoryDraftRepositoryError();
}

export async function createCategoryDraft(input: {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  source: ExpenseSource;
  operationType: AgentCategoryDraftOperation;
  payload: AgentCategoryDraftPayload;
}): Promise<AgentCategoryDraft> {
  const draft = await createAgentDraft({
    ...input,
    operationType: input.operationType,
    status: "AWAITING_CATEGORY",
  });
  return draft as AgentCategoryDraft;
}

export async function createAgentDraft(input: {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  source: ExpenseSource;
  operationType: AgentCategoryDraftOperation | null;
  status: AgentCategoryDraftStatus;
  payload: AgentCategoryDraftPayload;
}): Promise<AgentDraft> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .insert({
      id: input.id,
      household_id: input.householdId,
      actor_member_id: input.actorMemberId,
      conversation_key: input.conversationKey,
      source: input.source,
      operation_type: input.operationType,
      payload: input.payload,
      status: input.status,
    })
    .select(columns)
    .single();

  if (error || !data) handleError(error);
  return parseDraftRow(data);
}

export async function findActiveAgentDraft(
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  source: ExpenseSource,
): Promise<AgentDraft | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .select(columns)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("source", source)
    .maybeSingle();

  if (error) handleError(error);
  return data ? parseDraftRow(data) : null;
}

export async function findCategoryDraft(
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  source: ExpenseSource,
): Promise<AgentCategoryDraft | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .select(columns)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("source", source)
    .eq("status", "AWAITING_CATEGORY")
    .maybeSingle();

  if (error) handleError(error);
  return data ? (parseDraftRow(data) as AgentCategoryDraft) : null;
}

export async function updateAgentDraft(
  id: string,
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  source: ExpenseSource,
  operationType: AgentCategoryDraftOperation | null,
  status: AgentCategoryDraftStatus,
  payload: AgentCategoryDraftPayload,
  expectedUpdatedAt?: string,
): Promise<AgentDraft> {
  let query = getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .update({ payload, operation_type: operationType, status })
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey);
  query = query.eq("source", source);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select(columns).single();

  if (error || !data) handleError(error);
  return parseDraftRow(data);
}

export async function updateCategoryDraft(
  id: string,
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  source: ExpenseSource,
  payload: AgentCategoryDraftPayload,
  expectedUpdatedAt?: string,
): Promise<AgentCategoryDraft> {
  let query = getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .update({ payload })
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("source", source)
    .eq("status", "AWAITING_CATEGORY");
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select(columns).single();

  if (error || !data) handleError(error);
  return parseDraftRow(data) as AgentCategoryDraft;
}

export async function deleteAgentDraft(
  id: string,
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  source: ExpenseSource,
  expectedUpdatedAt: string,
): Promise<CategoryDraftDeleteResult> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_agent_category_drafts")
    .delete()
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("actor_member_id", actorMemberId)
    .eq("conversation_key", conversationKey)
    .eq("source", source)
    .eq("updated_at", expectedUpdatedAt)
    .select("id")
    .maybeSingle();

  if (error) handleError(error);
  if (data) return "DELETED";

  const { data: currentDraft, error: currentDraftError } =
    await getSupabaseAdminClient()
      .from("tb_agent_category_drafts")
      .select("id")
      .eq("id", id)
      .eq("household_id", householdId)
      .eq("actor_member_id", actorMemberId)
      .eq("conversation_key", conversationKey)
      .eq("source", source)
      .maybeSingle();

  if (currentDraftError) handleError(currentDraftError);
  return currentDraft ? "VERSION_CONFLICT" : "NOT_FOUND";
}

export async function deleteCategoryDraft(
  id: string,
  householdId: string,
  actorMemberId: string,
  conversationKey: string,
  source: ExpenseSource,
  expectedUpdatedAt: string,
): Promise<CategoryDraftDeleteResult> {
  return deleteAgentDraft(
    id,
    householdId,
    actorMemberId,
    conversationKey,
    source,
    expectedUpdatedAt,
  );
}
