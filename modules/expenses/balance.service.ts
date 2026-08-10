import { calculateBalance } from "./balance-calculator";
import {
  listBalanceHouseholdMembers,
  listConfirmedBalanceExpenses,
} from "./balance.repository";
import {
  BalanceDomainError,
  type BalanceResult,
  type BalanceServiceContext,
} from "./balance.types";
import { validateBalanceContext } from "./balance.validation";

export async function getBalance(
  context: BalanceServiceContext,
): Promise<BalanceResult> {
  try {
    validateBalanceContext(context);
    const memberIds = await listBalanceHouseholdMembers(context.householdId);
    const expenses = await listConfirmedBalanceExpenses(context.householdId);
    return { members: calculateBalance(memberIds, expenses) };
  } catch (error) {
    if (error instanceof BalanceDomainError) throw error;
    throw new BalanceDomainError(
      "PERSISTENCE_ERROR",
      "Balance could not be calculated.",
    );
  }
}
