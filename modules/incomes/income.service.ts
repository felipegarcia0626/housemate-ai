import {
  IncomeRepositoryError,
  isIncomeMemberInHousehold,
  listIncomes as listIncomesInRepository,
} from "./income.repository";
import {
  IncomeDomainError,
  type IncomeListFilters,
  type IncomeListResult,
  type IncomeServiceContext,
} from "./income.types";
import {
  toIncomeAmountCents,
  validateIncomeListFilters,
  validateIncomeUuid,
} from "./income.validation";

function persistenceError(): IncomeDomainError {
  return new IncomeDomainError(
    "PERSISTENCE_ERROR",
    "Incomes could not be loaded.",
  );
}

export async function listIncomes(
  context: IncomeServiceContext,
  filters: IncomeListFilters = {},
): Promise<IncomeListResult> {
  try {
    validateIncomeUuid(context.householdId, "context.householdId");
    validateIncomeListFilters(filters);

    if (
      filters.memberId !== undefined &&
      !(await isIncomeMemberInHousehold(context.householdId, filters.memberId))
    ) {
      throw new IncomeDomainError(
        "HOUSEHOLD_MISMATCH",
        "The selected member does not belong to the current household.",
      );
    }

    const incomes = await listIncomesInRepository(context.householdId, filters);
    const totalIncomeCents = incomes.reduce(
      (total, income, index) =>
        total + toIncomeAmountCents(income.amount, `incomes[${index}].amount`),
      BigInt(0),
    );

    return {
      incomes,
      summary: {
        totalIncome: Number(totalIncomeCents) / 100,
      },
    };
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      throw error;
    }

    if (error instanceof IncomeRepositoryError) {
      throw persistenceError();
    }

    throw persistenceError();
  }
}
