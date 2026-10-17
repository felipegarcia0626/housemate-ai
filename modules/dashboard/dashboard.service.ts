import { calculateDashboard } from "./dashboard-calculator";
import {
  listDashboardExpenses,
  listDashboardIncomes,
  readPeriodFinancialSnapshot,
  type PeriodFinancialSnapshot,
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

export async function getPeriodFinancialSnapshot(
  context: DashboardServiceContext,
  interval: { from: string; to: string },
  signal: AbortSignal,
): Promise<PeriodFinancialSnapshot> {
  validateDashboardContext(context);
  validateDashboardFilters(interval);
  return readPeriodFinancialSnapshot(context.householdId, interval.from, interval.to, signal);
}
