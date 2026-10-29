import { randomUUID } from "node:crypto";
import { listHierarchicalCategories } from "@/modules/categories/category.service";
import type { CategoryMovementType } from "@/modules/categories/category.types";
import {
  getExpenseById,
  prepareExpenseCreation,
  type ExpenseCreatePersistenceInput,
} from "@/modules/expenses/expense.service";
import {
  getIncomeById,
  prepareIncomeCreation,
  type IncomeCreatePersistenceInput,
} from "@/modules/incomes/income.service";
import {
  ExpenseDomainError,
  type ExpenseCreateInput,
} from "@/modules/expenses/expense.types";
import {
  AgentDomainError,
  type AgentContext,
  type ExpenseConfirmationResult,
  type ExpenseProposalInput,
  type ExpenseProposalResult,
  type ExpenseRejectionResult,
  type PendingExpenseProposal,
  type PendingExpenseProposalPayload,
  type PendingProposal,
  type IncomeConfirmationResult,
  type IncomeProposalResult,
  type IncomeRejectionResult,
  type PendingIncomeProposal,
  type PendingIncomeProposalPayload,
} from "./agent.types";
import {
  confirmPendingExpense,
  confirmPendingIncome,
  createPendingProposal,
  createPendingIncomeProposal,
  findPendingProposal,
  findPendingProposalForConversation,
  findLatestTerminalProposalForConversation,
  findPendingIncomeProposal,
  rejectPendingProposal,
  PendingProposalRepositoryError,
} from "./pending-proposal.repository";
import {
  IncomeDomainError,
  type IncomeCreateInput,
} from "@/modules/incomes/income.types";

function validateUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new AgentDomainError("VALIDATION_ERROR", `${field} is invalid.`);
  }
}

function validateContext(context: AgentContext): void {
  validateUuid(context.householdId, "context.householdId");
  validateUuid(context.actorMemberId, "context.actorMemberId");
  if (!context.conversationKey.trim()) {
    throw new AgentDomainError(
      "VALIDATION_ERROR",
      "context.conversationKey is required.",
    );
  }
  if (!new Set(["WEB", "WHATSAPP", "RECEIPT"]).has(context.source)) {
    throw new AgentDomainError(
      "VALIDATION_ERROR",
      "context.source is invalid.",
    );
  }
}

async function assertWhatsAppExecutionCurrent(
  context: AgentContext,
): Promise<void> {
  if (context.source !== "WHATSAPP") return;
  if (!context.whatsappExecution) {
    throw new AgentDomainError(
      "PERSISTENCE_ERROR",
      "The WhatsApp execution context is unavailable.",
    );
  }
  await context.whatsappExecution.assertCurrent();
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

function validateProposalShape(input: ExpenseProposalInput): void {
  if (!input || typeof input !== "object") {
    throw new AgentDomainError(
      "VALIDATION_ERROR",
      "Expense proposal is invalid.",
    );
  }
  if (!Array.isArray(input.splits) || input.splits.length === 0) {
    throw new AgentDomainError(
      "VALIDATION_ERROR",
      "Expense splits are required.",
    );
  }
}

async function requireActiveMicroCategory(
  categoryId: string | null | undefined,
  movementType: CategoryMovementType,
): Promise<void> {
  if (!categoryId || typeof categoryId !== "string") {
    throw new AgentDomainError("VALIDATION_ERROR", "A microcategory is required.");
  }
  let categories;
  try {
    categories = await listHierarchicalCategories(movementType);
  } catch {
    throw new AgentDomainError(
      "PERSISTENCE_ERROR",
      "The category catalog could not be checked.",
    );
  }
  if (!categories.some((category) =>
    category.id === categoryId &&
    category.level === "MICRO" &&
    category.isActive === true &&
    category.movementType === movementType &&
    category.parentId === category.macroId &&
    Boolean(category.macroName),
  )) {
    throw new AgentDomainError("VALIDATION_ERROR", "The microcategory is unavailable.");
  }
}

function persistenceError(): AgentDomainError {
  return new AgentDomainError(
    "PERSISTENCE_ERROR",
    "The pending proposal could not be persisted.",
  );
}

function proposalUnavailable(): AgentDomainError {
  return new AgentDomainError(
    "PROPOSAL_NOT_AVAILABLE",
    "The pending proposal is no longer available.",
  );
}

function ensureProposalOwnership(
  context: AgentContext,
  proposal: PendingExpenseProposal,
): void {
  if (
    proposal.payload.actorMemberId !== context.actorMemberId ||
    proposal.payload.source !== context.source
  ) {
    throw new AgentDomainError(
      "HOUSEHOLD_MISMATCH",
      "The pending proposal does not belong to the current context.",
    );
  }
}

function mapRepositoryError(error: unknown): AgentDomainError {
  if (
    error instanceof PendingProposalRepositoryError &&
    error.kind === "CONFLICT"
  ) {
    return new AgentDomainError(
      "PENDING_PROPOSAL_EXISTS",
      "A pending proposal already exists for this conversation.",
    );
  }
  return persistenceError();
}

export async function createExpenseProposal(
  context: AgentContext,
  input: ExpenseProposalInput,
  draftId?: string,
): Promise<ExpenseProposalResult> {
  await assertWhatsAppExecutionCurrent(context);
  validateContext(context);
  validateProposalShape(input);
  await requireActiveMicroCategory(input.categoryId, "EXPENSE");

  const payload: PendingExpenseProposalPayload = {
    actorMemberId: context.actorMemberId,
    source: context.source,
    ...(draftId ? { draftId } : {}),
    expense: input,
  };

  try {
    const proposal = await createPendingProposal({
      id: randomUUID(),
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      operationType: "CREATE_EXPENSE",
      payload,
      whatsappLease: whatsappLease(context),
    });
    return { proposalId: proposal.id, status: "AWAITING_CONFIRMATION" };
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

export async function createIncomeProposal(
  context: AgentContext,
  input: IncomeCreateInput,
  draftId?: string,
): Promise<IncomeProposalResult> {
  await assertWhatsAppExecutionCurrent(context);
  validateContext(context);
  await requireActiveMicroCategory(input.categoryId, "INCOME");
  const payload: PendingIncomeProposalPayload = {
    actorMemberId: context.actorMemberId,
    source: context.source,
    ...(draftId ? { draftId } : {}),
    income: input,
  };
  try {
    const proposal = await createPendingIncomeProposal({
      id: randomUUID(),
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      payload,
      whatsappLease: whatsappLease(context),
    });
    return { proposalId: proposal.id, status: "AWAITING_CONFIRMATION" };
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

async function getOwnedIncomeProposal(
  context: AgentContext,
  proposalId: string,
): Promise<PendingIncomeProposal> {
  validateContext(context);
  validateUuid(proposalId, "proposalId");
  const proposal = await findPendingIncomeProposal(
    proposalId,
    context.householdId,
    context.conversationKey,
  );
  if (!proposal) throw new AgentDomainError("NOT_FOUND", "Proposal not found.");
  ensureProposalOwnership(
    context,
    proposal as unknown as PendingExpenseProposal,
  );
  return proposal;
}

export async function confirmIncomeProposal(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeConfirmationResult | IncomeRejectionResult> {
  await assertWhatsAppExecutionCurrent(context);
  let proposal: PendingIncomeProposal | null = null;
  try {
    proposal = await getOwnedIncomeProposal(context, proposalId);
  } catch (error) {
    if (error instanceof AgentDomainError && error.code === "NOT_FOUND") {
      proposal = null;
    } else if (error instanceof AgentDomainError) {
      throw error;
    } else {
      throw mapRepositoryError(error);
    }
  }

  let persistenceInput: IncomeCreatePersistenceInput | null = null;
  if (proposal) {
    if (proposal.status === "AWAITING_CONFIRMATION") {
      await requireActiveMicroCategory(proposal.payload.income.categoryId, "INCOME");
    }
    try {
      persistenceInput = await prepareIncomeCreation(
        {
          householdId: context.householdId,
          memberId: context.actorMemberId,
        },
        proposal.payload.income,
      );
    } catch (error) {
      if (error instanceof IncomeDomainError) throw error;
      throw persistenceError();
    }
  }

  try {
    const result = await confirmPendingIncome({
      authUserId: context.authUserId,
      proposalId,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      actorMemberId: context.actorMemberId,
      source: context.source,
      expectedUpdatedAt: proposal?.updatedAt ?? null,
      income: persistenceInput,
      whatsappLease: whatsappLease(context),
    });
    if (result.status === "NOT_FOUND" || result.status === "INVALID_OPERATION") {
      throw proposalUnavailable();
    }
    if (result.status === "REJECTED") {
      return { proposalId, status: "REJECTED" };
    }
    if (!result.incomeId) throw persistenceError();
    let income: Awaited<ReturnType<typeof getIncomeById>> | null = null;
    try {
      income = await getIncomeById(
        { householdId: context.householdId },
        result.incomeId,
      );
    } catch (error) {
      if (!(error instanceof IncomeDomainError) || error.code !== "NOT_FOUND") {
        throw error;
      }
    }
    return {
      proposalId,
      status: income ? "CONFIRMED" : "ALREADY_COMPLETED",
      incomeId: result.incomeId,
      income,
    };
  } catch (error) {
    if (error instanceof PendingProposalRepositoryError && error.kind === "ACCOUNT_NOT_ELIGIBLE") {
      throw new AgentDomainError("ACCOUNT_NOT_ELIGIBLE", "Financial access is unavailable.");
    }
    if (error instanceof AgentDomainError) throw error;
    if (error instanceof IncomeDomainError) throw error;
    throw persistenceError();
  }
}

export async function rejectIncomeProposal(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeRejectionResult> {
  return rejectProposal(context, proposalId, "CREATE_INCOME");
}

export async function confirmAgentProposal(
  context: AgentContext,
  proposalId: string,
): Promise<
  | ExpenseConfirmationResult
  | ExpenseRejectionResult
  | IncomeConfirmationResult
  | IncomeRejectionResult
> {
  try {
    return await confirmExpenseProposal(context, proposalId);
  } catch (error) {
    if (!(error instanceof AgentDomainError)) throw error;
    if (error.code !== "PROPOSAL_NOT_AVAILABLE") throw error;
    return confirmIncomeProposal(context, proposalId);
  }
}

export async function rejectAgentProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseRejectionResult | IncomeRejectionResult> {
  try {
    return await rejectExpenseProposal(context, proposalId);
  } catch (error) {
    if (!(error instanceof AgentDomainError)) throw error;
    if (error.code !== "PROPOSAL_NOT_AVAILABLE") throw error;
    return rejectIncomeProposal(context, proposalId);
  }
}

async function getOwnedProposal(
  context: AgentContext,
  proposalId: string,
): Promise<PendingExpenseProposal> {
  validateContext(context);
  validateUuid(proposalId, "proposalId");
  const proposal = await findPendingProposal(
    proposalId,
    context.householdId,
    context.conversationKey,
  );
  if (!proposal) throw new AgentDomainError("NOT_FOUND", "Proposal not found.");
  ensureProposalOwnership(context, proposal);
  return proposal;
}

export async function getExpenseProposal(
  context: AgentContext,
  proposalId: string,
): Promise<PendingExpenseProposal> {
  try {
    return await getOwnedProposal(context, proposalId);
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

export async function findActiveProposalId(
  context: AgentContext,
): Promise<string | null> {
  validateContext(context);
  try {
    const proposal = await findPendingProposalForConversation(
      context.householdId,
      context.conversationKey,
      context.actorMemberId,
      context.source,
    );
    return proposal?.id ?? null;
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

export async function findLatestTerminalProposal(
  context: AgentContext,
): Promise<PendingProposal | null> {
  validateContext(context);
  try {
    const proposal = await findLatestTerminalProposalForConversation(
      context.householdId,
      context.conversationKey,
      context.actorMemberId,
      context.source,
    );
    if (!proposal) return null;
    if (
      proposal.payload.actorMemberId !== context.actorMemberId ||
      proposal.payload.source !== context.source
    ) {
      return null;
    }
    return proposal;
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

export async function getTerminalProposalResult(
  context: AgentContext,
  proposal: PendingProposal,
): Promise<
  | ExpenseConfirmationResult
  | ExpenseRejectionResult
  | IncomeConfirmationResult
  | IncomeRejectionResult
> {
  validateContext(context);
  ensureProposalOwnership(
    context,
    proposal as unknown as PendingExpenseProposal,
  );

  if (proposal.status === "REJECTED") {
    return { proposalId: proposal.id, status: "REJECTED" };
  }

  if (proposal.operationType === "CREATE_EXPENSE") {
    if (!proposal.expenseId) throw persistenceError();
    try {
      const expense = await getExpenseById(
        { householdId: context.householdId },
        proposal.expenseId,
      );
      return {
        proposalId: proposal.id,
        status: "CONFIRMED",
        expenseId: expense.id,
        expense,
      };
    } catch (error) {
      if (error instanceof ExpenseDomainError) throw error;
      throw persistenceError();
    }
  }

  if (!proposal.incomeId) throw persistenceError();
  let income: Awaited<ReturnType<typeof getIncomeById>> | null = null;
  try {
    income = await getIncomeById(
      { householdId: context.householdId },
      proposal.incomeId,
    );
  } catch (error) {
    if (!(error instanceof IncomeDomainError) || error.code !== "NOT_FOUND") {
      throw error;
    }
  }
  return {
    proposalId: proposal.id,
    status: income ? "CONFIRMED" : "ALREADY_COMPLETED",
    incomeId: proposal.incomeId,
    income,
  };
}

export async function confirmExpenseProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseConfirmationResult | ExpenseRejectionResult> {
  await assertWhatsAppExecutionCurrent(context);
  let proposal: PendingExpenseProposal | null = null;
  try {
    proposal = await getOwnedProposal(context, proposalId);
  } catch (error) {
    if (!(error instanceof AgentDomainError)) throw mapRepositoryError(error);
    if (error.code !== "NOT_FOUND" && error.code !== "PROPOSAL_NOT_AVAILABLE") {
      throw error;
    }
  }

  let persistenceInput: ExpenseCreatePersistenceInput | null = null;
  if (proposal) {
    if (proposal.status === "AWAITING_CONFIRMATION") {
      await requireActiveMicroCategory(proposal.payload.expense.categoryId, "EXPENSE");
    }
    const input: ExpenseCreateInput = {
      ...proposal.payload.expense,
      createdBy: context.actorMemberId,
      source: context.source,
    };
    try {
      persistenceInput = await prepareExpenseCreation(
        { householdId: context.householdId },
        input,
      );
    } catch (error) {
      if (error instanceof ExpenseDomainError) throw error;
      throw persistenceError();
    }
  }

  try {
    const result = await confirmPendingExpense({
      authUserId: context.authUserId,
      proposalId,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      actorMemberId: context.actorMemberId,
      source: context.source,
      expectedUpdatedAt: proposal?.updatedAt ?? null,
      expense: persistenceInput,
      whatsappLease: whatsappLease(context),
    });
    if (result.status === "NOT_FOUND" || result.status === "INVALID_OPERATION") {
      throw proposalUnavailable();
    }
    if (result.status === "REJECTED") {
      return { proposalId, status: "REJECTED" };
    }
    if (!result.expenseId) throw persistenceError();
    const expense = await getExpenseById(
      { householdId: context.householdId },
      result.expenseId,
    );
    return {
      proposalId,
      status: "CONFIRMED",
      expenseId: expense.id,
      expense,
    };
  } catch (error) {
    if (error instanceof PendingProposalRepositoryError && error.kind === "ACCOUNT_NOT_ELIGIBLE") {
      throw new AgentDomainError("ACCOUNT_NOT_ELIGIBLE", "Financial access is unavailable.");
    }
    if (error instanceof AgentDomainError) throw error;
    if (error instanceof ExpenseDomainError) throw error;
    throw persistenceError();
  }
}

export async function rejectExpenseProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseRejectionResult> {
  return rejectProposal(context, proposalId, "CREATE_EXPENSE");
}

async function rejectProposal(
  context: AgentContext,
  proposalId: string,
  operationType: "CREATE_EXPENSE" | "CREATE_INCOME",
): Promise<{ proposalId: string; status: "REJECTED" }> {
  try {
    validateContext(context);
    validateUuid(proposalId, "proposalId");
    const result = await rejectPendingProposal({
      proposalId,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      actorMemberId: context.actorMemberId,
      source: context.source,
      operationType,
      whatsappLease: whatsappLease(context),
    });
    if (result.status === "REJECTED") {
      return { proposalId, status: "REJECTED" };
    }
    throw proposalUnavailable();
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}
