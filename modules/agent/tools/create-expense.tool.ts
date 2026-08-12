import {
  confirmExpenseProposal,
  createExpenseProposal,
  rejectExpenseProposal,
} from "@/modules/agent/agent.service";
import type {
  AgentContext,
  ExpenseConfirmationResult,
  ExpenseProposalInput,
  ExpenseProposalResult,
  ExpenseRejectionResult,
} from "@/modules/agent/agent.types";

export async function createExpenseTool(
  context: AgentContext,
  input: ExpenseProposalInput,
): Promise<ExpenseProposalResult> {
  return createExpenseProposal(context, input);
}

export async function confirmCreateExpenseTool(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseConfirmationResult> {
  return confirmExpenseProposal(context, proposalId);
}

export async function rejectCreateExpenseTool(
  context: AgentContext,
  proposalId: string,
): Promise<ExpenseRejectionResult> {
  return rejectExpenseProposal(context, proposalId);
}
