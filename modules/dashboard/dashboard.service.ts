import { calculateDashboard } from "./dashboard-calculator";
import {
  listDashboardExpenses,
  listDashboardIncomes,
} from "./dashboard.repository";
import {
  DashboardDomainError,
  type DashboardFilters,
  type DashboardResult,
  type DashboardServiceContext,
} from "./dashboard.types";
import {
  validateDashboardContext,
  validateDashboardFilters,
} from "./dashboard.validation";

export async function getDashboard(
  context: DashboardServiceContext,
  filters: DashboardFilters = {},
): Promise<DashboardResult> {
  try {
    validateDashboardContext(context);
    validateDashboardFilters(filters);

    const incomes = await listDashboardIncomes(context.householdId, filters);
    const expenses = await listDashboardExpenses(context.householdId, filters);
    return calculateDashboard(incomes, expenses);
  } catch (error) {
    if (error instanceof DashboardDomainError) throw error;
    throw new DashboardDomainError(
      "PERSISTENCE_ERROR",
      "Dashboard could not be calculated.",
    );
  }
}
