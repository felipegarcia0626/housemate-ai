import type { ExpenseSource } from "@/modules/expenses/expense.types";
import type { IncomeCreateInput } from "@/modules/incomes/income.types";
import type { ExpenseProposalInput } from "./agent.types";

export type AgentCategoryDraftOperation = "CREATE_EXPENSE" | "CREATE_INCOME";

export interface CategoryDraftExpensePayload {
  actorMemberId: string;
  source: ExpenseSource;
  expense: ExpenseProposalInput;
}

export interface CategoryDraftIncomePayload {
  actorMemberId: string;
  source: ExpenseSource;
  income: IncomeCreateInput;
}

export type AgentCategoryDraftPayload =
  CategoryDraftExpensePayload | CategoryDraftIncomePayload;

export interface AgentCategoryDraft {
  id: string;
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  operationType: AgentCategoryDraftOperation;
  payload: AgentCategoryDraftPayload;
  status: "AWAITING_CATEGORY";
  createdAt: string;
  updatedAt: string;
}
