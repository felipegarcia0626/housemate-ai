import { listExpenses } from "@/modules/expenses/expense.service";
import type {
  ExpenseListItem,
  ExpenseReadFilters,
} from "@/modules/expenses/expense.types";
import type { AgentContext } from "../agent.types";

export async function getExpensesTool(
  context: AgentContext,
  filters: ExpenseReadFilters = {},
): Promise<ExpenseListItem[]> {
  return listExpenses({ householdId: context.householdId }, filters);
}
