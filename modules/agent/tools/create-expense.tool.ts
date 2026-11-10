import {
  confirmExpenseProposal,
  createExpenseProposal,
  rejectExpenseProposal,
} from "@/modules/agent/agent.service";
import type {
  AgentContext,
  ExpenseConfirmationResult,
  ExpenseProposalInput,
  ExpenseRejectionResult,
  PendingProposalCreationResult,
} from "@/modules/agent/agent.types";

export async function createExpenseTool(
  context: AgentContext,
  input: ExpenseProposalInput,
  draftId?: string,
): Promise<PendingProposalCreationResult> {
  return createExpenseProposal(context, input, draftId);
}

export async function confirmCreateExpenseTool(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseConfirmationResult | ExpenseRejectionResult> {
  return confirmExpenseProposal(context, proposalId);
}

export async function rejectCreateExpenseTool(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseRejectionResult> {
  return rejectExpenseProposal(context, proposalId);
}
