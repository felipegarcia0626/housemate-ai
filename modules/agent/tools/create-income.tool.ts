import {
  confirmIncomeProposal,
  createIncomeProposal,
  rejectIncomeProposal,
} from "@/modules/agent/agent.service";
import type {
  AgentContext,
  IncomeConfirmationResult,
  IncomeProposalResult,
  IncomeRejectionResult,
} from "@/modules/agent/agent.types";
import type { IncomeCreateInput } from "@/modules/incomes/income.types";

export async function createIncomeTool(
  context: AgentContext,
  input: IncomeCreateInput,
  draftId?: string,
): Promise<IncomeProposalResult> {
  return createIncomeProposal(context, input, draftId);
}

export async function confirmCreateIncomeTool(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeConfirmationResult | IncomeRejectionResult> {
  return confirmIncomeProposal(context, proposalId);
}

export async function rejectCreateIncomeTool(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeRejectionResult> {
  return rejectIncomeProposal(context, proposalId);
}
