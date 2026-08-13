import { randomUUID } from "node:crypto";
import { createExpense } from "@/modules/expenses/expense.service";
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
  consumePendingProposal,
  createPendingProposal,
  consumePendingIncomeProposal,
  createPendingIncomeProposal,
  findPendingProposal,
  findPendingIncomeProposal,
  PendingProposalRepositoryError,
  restorePendingProposal,
  restorePendingIncomeProposal,
} from "./pending-proposal.repository";
import { createIncome } from "@/modules/incomes/income.service";
import type { IncomeCreateInput } from "@/modules/incomes/income.types";

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
): Promise<IncomeConfirmationResult> {
  let proposal: PendingIncomeProposal;
  try {
    proposal = await getOwnedIncomeProposal(context, proposalId);
  } catch (error) {
    if (error instanceof AgentDomainError && error.code === "NOT_FOUND") {
      throw proposalUnavailable();
    }
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
  const consumed = await consumePendingIncomeProposal(
    proposal.id,
    context.householdId,
    context.conversationKey,
  );
  if (!consumed) throw proposalUnavailable();
  try {
    const income = await createIncome(
      { householdId: context.householdId, memberId: context.actorMemberId },
      consumed.payload.income,
    );
    return {
      proposalId: consumed.id,
      status: "CONFIRMED",
      incomeId: income.id,
      income,
    };
  } catch (error) {
    try {
      await restorePendingIncomeProposal(consumed);
    } catch {
      throw persistenceError();
    }
    if (error instanceof AgentDomainError) throw error;
    throw persistenceError();
  }
}

export async function rejectIncomeProposal(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeRejectionResult> {
  try {
    const proposal = await getOwnedIncomeProposal(context, proposalId);
    const consumed = await consumePendingIncomeProposal(
      proposal.id,
      context.householdId,
      context.conversationKey,
    );
    if (!consumed) throw proposalUnavailable();
    return { proposalId: consumed.id, status: "REJECTED" };
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}

export async function confirmAgentProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseConfirmationResult | IncomeConfirmationResult> {
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

async function consumeOwnedProposal(
  context: AgentContext,
  proposalId: string,
): Promise<PendingExpenseProposal> {
  let proposal: PendingExpenseProposal;
  try {
    proposal = await getOwnedProposal(context, proposalId);
  } catch (error) {
    if (error instanceof AgentDomainError && error.code === "NOT_FOUND") {
      throw proposalUnavailable();
    }
    throw error;
  }
  const consumed = await consumePendingProposal(
    proposal.id,
    context.householdId,
    context.conversationKey,
  );
  if (!consumed) throw proposalUnavailable();
  ensureProposalOwnership(context, consumed);
  return consumed;
}

export async function confirmExpenseProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseConfirmationResult> {
  let proposal: PendingExpenseProposal;
  try {
    proposal = await consumeOwnedProposal(context, proposalId);
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }

  const input: ExpenseCreateInput = {
    ...proposal.payload.expense,
    createdBy: context.actorMemberId,
    source: context.source,
  };

  try {
    const expense = await createExpense(
      { householdId: context.householdId },
      input,
    );
    return {
      proposalId: proposal.id,
      status: "CONFIRMED",
      expenseId: expense.id,
      expense,
    };
  } catch (error) {
    if (
      error instanceof ExpenseDomainError &&
      error.code === "CREATED_NOT_HYDRATED"
    ) {
      throw error;
    }
    try {
      await restorePendingProposal(proposal);
    } catch {
      throw persistenceError();
    }
    if (error instanceof ExpenseDomainError) throw error;
    throw persistenceError();
  }
}

export async function rejectExpenseProposal(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseRejectionResult> {
  try {
    const proposal = await consumeOwnedProposal(context, proposalId);
    return { proposalId: proposal.id, status: "REJECTED" };
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw mapRepositoryError(error);
  }
}
