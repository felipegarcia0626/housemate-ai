import { randomUUID } from "node:crypto";
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
): Promise<ExpenseProposalResult> {
  validateContext(context);
  validateProposalShape(input);

  const payload: PendingExpenseProposalPayload = {
    actorMemberId: context.actorMemberId,
    source: context.source,
    expense: input,
  };

  try {
    const proposal = await createPendingProposal({
      id: randomUUID(),
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      operationType: "CREATE_EXPENSE",
      payload,
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
): Promise<IncomeProposalResult> {
  validateContext(context);
  const payload: PendingIncomeProposalPayload = {
    actorMemberId: context.actorMemberId,
    source: context.source,
    income: input,
  };
  try {
    const proposal = await createPendingIncomeProposal({
      id: randomUUID(),
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      payload,
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
      proposalId,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      actorMemberId: context.actorMemberId,
      source: context.source,
      expectedUpdatedAt: proposal?.updatedAt ?? null,
      income: persistenceInput,
    });
    if (result.status === "NOT_FOUND" || result.status === "INVALID_OPERATION") {
      throw proposalUnavailable();
    }
    if (result.status === "REJECTED") {
      return { proposalId, status: "REJECTED" };
    }
    if (!result.incomeId) throw persistenceError();
    const income = await getIncomeById(
      { householdId: context.householdId },
      result.incomeId,
    );
    return {
      proposalId,
      status: "CONFIRMED",
      incomeId: income.id,
      income,
    };
  } catch (error) {
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
    );
    return proposal?.id ?? null;
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

export async function confirmExpenseProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseConfirmationResult | ExpenseRejectionResult> {
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
      proposalId,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      actorMemberId: context.actorMemberId,
      source: context.source,
      expectedUpdatedAt: proposal?.updatedAt ?? null,
      expense: persistenceInput,
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
