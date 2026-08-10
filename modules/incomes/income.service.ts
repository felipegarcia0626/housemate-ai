import {
  createIncome as createIncomeInRepository,
  IncomeRepositoryError,
  isIncomeCategoryAvailable,
  isIncomeMemberInHousehold,
  listIncomes as listIncomesInRepository,
} from "./income.repository";
import {
  IncomeDomainError,
  type Income,
  type IncomeCreateInput,
  type IncomeCreateServiceContext,
  type IncomeListFilters,
  type IncomeListResult,
  type IncomeServiceContext,
} from "./income.types";
import {
  toIncomeAmountCents,
  validateIncomeCreateInput,
  validateIncomeListFilters,
  validateIncomeUuid,
} from "./income.validation";

function persistenceError(): IncomeDomainError {
  return new IncomeDomainError(
    "PERSISTENCE_ERROR",
    "Incomes could not be loaded.",
  );
}

function createPersistenceError(): IncomeDomainError {
  return new IncomeDomainError(
    "PERSISTENCE_ERROR",
    "Income could not be created.",
  );
}

export async function createIncome(
  context: IncomeCreateServiceContext,
  input: IncomeCreateInput,
): Promise<Income> {
  try {
    validateIncomeUuid(context.householdId, "context.householdId");
    validateIncomeUuid(context.memberId, "context.memberId");
    validateIncomeCreateInput(input);

    const [creatorBelongsToHousehold, memberBelongsToHousehold] =
      await Promise.all([
        isIncomeMemberInHousehold(context.householdId, context.memberId),
        isIncomeMemberInHousehold(context.householdId, input.memberId),
      ]);

    if (!creatorBelongsToHousehold || !memberBelongsToHousehold) {
      throw new IncomeDomainError(
        "HOUSEHOLD_MISMATCH",
        "One or more selected members do not belong to the current household.",
      );
    }

    const categoryId = input.categoryId ?? null;
    if (categoryId !== null && !(await isIncomeCategoryAvailable(categoryId))) {
      throw new IncomeDomainError(
        "NOT_FOUND",
        "The selected category was not found.",
      );
    }

    return await createIncomeInRepository({
      ...input,
      householdId: context.householdId,
      createdBy: context.memberId,
      categoryId,
    });
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      throw error;
    }

    if (error instanceof IncomeRepositoryError && error.kind === "INTEGRITY") {
      throw new IncomeDomainError(
        "VALIDATION_ERROR",
        "Income data is no longer valid for creation.",
      );
    }

    throw createPersistenceError();
  }
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
