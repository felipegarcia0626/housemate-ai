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
): Promise<IncomeProposalResult> {
  return createIncomeProposal(context, input);
}

export async function confirmCreateIncomeTool(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeConfirmationResult> {
  return confirmIncomeProposal(context, proposalId);
}

export async function rejectCreateIncomeTool(
  context: AgentContext,
  proposalId: string,
): Promise<IncomeRejectionResult> {
  return rejectIncomeProposal(context, proposalId);
}
