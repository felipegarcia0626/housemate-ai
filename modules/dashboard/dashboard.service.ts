import { calculateDashboard } from "./dashboard-calculator";
import {
  listDashboardExpenses,
  listDashboardIncomes,
  readPeriodFinancialSnapshot,
  readPeriodExpenseCategoryData,
  readPeriodFinancialCategoryData,
  type PeriodFinancialSnapshot,
} from "./dashboard.repository";
import {
  DashboardDomainError,
  type DashboardFilters,
  type DashboardResult,
  type DashboardServiceContext,
  type PeriodExpenseCategoryData,
  type PeriodFinancialCategoryData,
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

export async function getPeriodExpenseCategoryData(
  context: DashboardServiceContext,
  interval: { from: string; to: string },
  signal: AbortSignal,
): Promise<PeriodExpenseCategoryData> {
  validateDashboardContext(context);
  validateDashboardFilters(interval);
  try {
    return await readPeriodExpenseCategoryData(
      context.householdId,
      interval.from,
      interval.to,
      signal,
    );
  } catch (error) {
    if (error instanceof DashboardDomainError) throw error;
    throw new DashboardDomainError(
      "PERSISTENCE_ERROR",
      "Expense category summary could not be loaded.",
    );
  }
}

export async function getPeriodFinancialCategoryData(
  context: DashboardServiceContext,
  interval: { from: string; to: string },
  signal: AbortSignal,
): Promise<PeriodFinancialCategoryData> {
  validateDashboardContext(context);
  validateDashboardFilters(interval);
  try {
    return await readPeriodFinancialCategoryData(
      context.householdId,
      interval.from,
      interval.to,
      signal,
    );
  } catch (error) {
    if (error instanceof DashboardDomainError) throw error;
    throw new DashboardDomainError(
      "PERSISTENCE_ERROR",
      "Financial category summary could not be loaded.",
    );
  }
}
