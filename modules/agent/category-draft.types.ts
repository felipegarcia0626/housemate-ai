import type { ExpenseSource } from "@/modules/expenses/expense.types";
import type { IncomeCreateInput } from "@/modules/incomes/income.types";
import type { ExpenseProposalInput } from "./agent.types";

export type AgentCategoryDraftOperation = "CREATE_EXPENSE" | "CREATE_INCOME";

export type AgentCategoryDraftStatus =
  | "AWAITING_OPERATION"
  | "AWAITING_DETAILS"
  | "AWAITING_CATEGORY";

export interface AgentOperationDraftPayload {
  amount: string | null;
  date: string | null;
  merchant: string | null;
  description: string | null;
  paidBySelf: boolean | null;
  paidByMemberName: string | null;
  categoryName: string | null;
}

export interface CategoryDraftExpensePayload {
  actorMemberId?: string;
  source?: ExpenseSource;
  expense: Omit<ExpenseProposalInput, "splits"> & {
    splits?: ExpenseProposalInput["splits"];
  };
}

export interface CategoryDraftIncomePayload {
  actorMemberId?: string;
  source?: ExpenseSource;
  income: Omit<IncomeCreateInput, "memberId"> & { memberId?: string };
}

export type AgentCategoryDraftPayload =
  | AgentOperationDraftPayload
  | CategoryDraftExpensePayload
  | CategoryDraftIncomePayload;

export interface AgentOperationDraft {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  operationType: null;
  payload: AgentOperationDraftPayload;
  status: "AWAITING_OPERATION";
  createdAt: string;
  updatedAt: string;
}

export interface AgentDetailsDraft {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  operationType: AgentCategoryDraftOperation;
  payload: AgentOperationDraftPayload;
  status: "AWAITING_DETAILS";
  createdAt: string;
  updatedAt: string;
}

export interface AgentCategoryDraft {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  operationType: AgentCategoryDraftOperation;
  payload: CategoryDraftExpensePayload | CategoryDraftIncomePayload;
  status: "AWAITING_CATEGORY";
  createdAt: string;
  updatedAt: string;
}

export type AgentDraft =
  | AgentOperationDraft
  | AgentDetailsDraft
  | AgentCategoryDraft;
