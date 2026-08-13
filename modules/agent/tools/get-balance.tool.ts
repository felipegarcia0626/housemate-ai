import { getBalance } from "@/modules/expenses/balance.service";
import type {
  BalanceResult,
  BalanceServiceContext,
} from "@/modules/expenses/balance.types";
import type { AgentContext } from "../agent.types";

export async function getBalanceTool(
  context: AgentContext,
): Promise<BalanceResult> {
  const serviceContext: BalanceServiceContext = {
    householdId: context.householdId,
  };
  return getBalance(serviceContext);
}
