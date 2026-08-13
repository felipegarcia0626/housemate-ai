import { listIncomes } from "@/modules/incomes/income.service";
import type {
  IncomeListFilters,
  IncomeListResult,
} from "@/modules/incomes/income.types";
import type { AgentContext } from "../agent.types";

export async function getIncomesTool(
  context: AgentContext,
  filters: IncomeListFilters = {},
): Promise<IncomeListResult> {
  return listIncomes({ householdId: context.householdId }, filters);
}
