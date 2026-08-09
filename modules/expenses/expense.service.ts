import {
  findExpenseById,
  isHouseholdMemberInHousehold,
  listConfirmedExpenses,
} from "./expense.repository";
import {
  ExpenseDomainError,
  type Expense,
  type ExpenseListItem,
  type ExpenseReadFilters,
  type ExpenseServiceContext,
} from "./expense.types";
import { validateExpenseReadFilters, validateUuid } from "./expense.validation";

function validateContext(context: ExpenseServiceContext): void {
  validateUuid(context.householdId, "context.householdId");
}

export async function getExpense(
  context: ExpenseServiceContext,
  id: string,
): Promise<Expense> {
  validateContext(context);
  validateUuid(id, "id");

  const expense = await findExpenseById(context.householdId, id);

  if (expense === null) {
    throw new ExpenseDomainError(
      "NOT_FOUND",
      "Expense was not found in the current household.",
    );
  }

  return expense;
}

export async function listExpenses(
  context: ExpenseServiceContext,
  filters: ExpenseReadFilters = {},
): Promise<ExpenseListItem[]> {
  validateContext(context);
  validateExpenseReadFilters(filters);

  if (
    filters.memberId !== undefined &&
    !(await isHouseholdMemberInHousehold(context.householdId, filters.memberId))
  ) {
    throw new ExpenseDomainError(
      "HOUSEHOLD_MISMATCH",
      "The selected member does not belong to the current household.",
    );
  }

  return listConfirmedExpenses(context.householdId, filters);
}
