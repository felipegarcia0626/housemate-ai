import type {
  ExpenseCreateInput,
  Expense,
  ExpenseSource,
} from "@/modules/expenses/expense.types";

export interface AgentContext {
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  source: ExpenseSource;
}

export interface ConversationIdentity {
  conversationKey: string;
}

export type ExpenseProposalInput = Omit<
  ExpenseCreateInput,
  "createdBy" | "source"
>;

export interface PendingExpenseProposalPayload {
  actorMemberId: string;
  source: ExpenseSource;
  expense: ExpenseProposalInput;
}

export interface PendingExpenseProposal {
  id: string;
  householdId: string;
  conversationKey: string;
  operationType: "CREATE_EXPENSE";
  payload: PendingExpenseProposalPayload;
  status: "AWAITING_CONFIRMATION";
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseProposalResult {
  proposalId: string;
  status: "AWAITING_CONFIRMATION";
}

export interface ExpenseConfirmationResult {
  proposalId: string;
  status: "CONFIRMED";
  expenseId: string;
  expense: Expense;
}

export interface ExpenseRejectionResult {
  proposalId: string;
  status: "REJECTED";
}

export type AgentDomainErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "HOUSEHOLD_MISMATCH"
  | "PENDING_PROPOSAL_EXISTS"
  | "PROPOSAL_NOT_AVAILABLE"
  | "INTERPRETATION_ERROR"
  | "PERSISTENCE_ERROR";

export class AgentDomainError extends Error {
  readonly code: AgentDomainErrorCode;

  constructor(code: AgentDomainErrorCode, message: string) {
    super(message);
    this.name = "AgentDomainError";
    this.code = code;
  }
}

export interface AgentMessageInput {
  message: string;
  proposalId?: string;
}

export interface AgentClarificationResult {
  type: "CLARIFICATION_REQUIRED";
  missingFields: string[];
  message: string;
}

export interface AgentProposalMessageResult extends ExpenseProposalResult {
  type: "PROPOSAL_CREATED";
}

export interface AgentConfirmedMessageResult extends ExpenseConfirmationResult {
  type: "CONFIRMED";
}

export interface AgentRejectedMessageResult extends ExpenseRejectionResult {
  type: "REJECTED";
}

export interface AgentUnsupportedMessageResult {
  type: "UNSUPPORTED";
  message: string;
}

export interface AgentInterpretationErrorResult {
  type: "ERROR";
  code: "INTERPRETATION_ERROR";
  message: string;
}

export type AgentMessageResult =
  | AgentProposalMessageResult
  | AgentConfirmedMessageResult
  | AgentRejectedMessageResult
  | AgentClarificationResult
  | AgentUnsupportedMessageResult
  | AgentInterpretationErrorResult;
