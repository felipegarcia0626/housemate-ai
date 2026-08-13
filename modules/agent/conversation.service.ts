import { createExpenseTool } from "./tools/create-expense.tool";
import { confirmAgentProposal, rejectAgentProposal } from "./agent.service";
import { createIncomeTool } from "./tools/create-income.tool";
import type {
  AgentContext,
  AgentMessageInput,
  AgentMessageResult,
  ExpenseProposalInput,
} from "./agent.types";
import { AgentDomainError } from "./agent.types";
import {
  interpretExpenseMessage,
  type ExpenseInterpretation,
} from "@/infrastructure/openai/openai.adapter";

type Interpreter = (message: string) => Promise<ExpenseInterpretation>;

function isConfirmation(message: string): boolean {
  return /^(?:si|sí|ok|confirmo|confirmar|acepto|yes)(?:\s|$)/i.test(
    message.trim(),
  );
}

function isRejection(message: string): boolean {
  return /^(?:no|rechazo|rechazar|cancelar|cancelo)(?:\s|$)/i.test(
    message.trim(),
  );
}

function clarification(missingFields: string[]): AgentMessageResult {
  return {
    type: "CLARIFICATION_REQUIRED",
    missingFields,
    message: "Necesito más información para preparar el gasto.",
  };
}

function toAmount(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function toProposalInput(
  context: AgentContext,
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_EXPENSE" }>,
): { input: ExpenseProposalInput; missingFields: string[] } {
  const totalAmount = toAmount(interpretation.totalAmount);
  const missingFields: string[] = [];
  if (totalAmount === null) missingFields.push("totalAmount");
  if (!interpretation.expenseDate) missingFields.push("expenseDate");
  if (interpretation.paidBySelf !== true) missingFields.push("paidBySelf");
  if (missingFields.length > 0) {
    return { input: {} as ExpenseProposalInput, missingFields };
  }
  return {
    input: {
      paidByMemberId: context.actorMemberId,
      totalAmount: totalAmount as number,
      expenseDate: interpretation.expenseDate as string,
      merchant: interpretation.merchant,
      description: interpretation.description,
      items: [],
      splits: [{ householdMemberId: context.actorMemberId, percentage: 100 }],
    },
    missingFields,
  };
}

export async function processAgentMessage(
  context: AgentContext,
  input: AgentMessageInput,
  interpreter: Interpreter = interpretExpenseMessage,
): Promise<AgentMessageResult> {
  const message = input.message.trim();
  if (isConfirmation(message)) {
    if (!input.proposalId) return clarification(["proposalId"]);
    const result = await confirmAgentProposal(context, input.proposalId);
    return { type: "CONFIRMED", ...result };
  }
  if (isRejection(message)) {
    if (!input.proposalId) return clarification(["proposalId"]);
    const result = await rejectAgentProposal(context, input.proposalId);
    return { type: "REJECTED", ...result };
  }
  if (!message)
    return { type: "UNSUPPORTED", message: "No pude interpretar el mensaje." };

  let interpretation: ExpenseInterpretation;
  try {
    interpretation = await interpreter(message);
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    return {
      type: "ERROR",
      code: "INTERPRETATION_ERROR",
      message: "No pude interpretar el mensaje.",
    };
  }
  if (interpretation.kind === "UNSUPPORTED") {
    return {
      type: "UNSUPPORTED",
      message: "No pude interpretarlo como un gasto.",
    };
  }
  if (interpretation.kind === "CREATE_INCOME") {
    const amount = toAmount(interpretation.amount);
    const missingFields: string[] = [];
    if (amount === null) missingFields.push("amount");
    if (!interpretation.incomeDate) missingFields.push("incomeDate");
    if (!interpretation.description?.trim()) missingFields.push("description");
    if (missingFields.length > 0) return clarification(missingFields);
    const result = await createIncomeTool(context, {
      memberId: context.actorMemberId,
      amount: amount as number,
      incomeDate: interpretation.incomeDate as string,
      description: interpretation.description as string,
      categoryId: null,
    });
    return { type: "PROPOSAL_CREATED", ...result };
  }
  const proposal = toProposalInput(context, interpretation);
  if (proposal.missingFields.length > 0) {
    return clarification(proposal.missingFields);
  }
  const result = await createExpenseTool(context, proposal.input);
  return {
    type: "PROPOSAL_CREATED",
    ...result,
  };
}
