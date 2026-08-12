import {
  createIncome as createIncomeInRepository,
  deleteIncome as deleteIncomeInRepository,
  IncomeRepositoryError,
  isIncomeCategoryAvailable,
  isIncomeMemberInHousehold,
  listIncomes as listIncomesInRepository,
  type IncomeUpdatePersistenceInput,
  updateIncome as updateIncomeInRepository,
} from "./income.repository";
import {
  IncomeDomainError,
  type Income,
  type IncomeCreateInput,
  type IncomeCreateServiceContext,
  type IncomeDeleteResult,
  type IncomeListFilters,
  type IncomeListResult,
  type IncomeServiceContext,
  type IncomeUpdateInput,
} from "./income.types";
import {
  toIncomeAmountCents,
  validateIncomeCreateInput,
  validateIncomeListFilters,
  validateIncomeUpdateInput,
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

function updatePersistenceError(): IncomeDomainError {
  return new IncomeDomainError(
    "PERSISTENCE_ERROR",
    "Income could not be updated.",
  );
}

function deletePersistenceError(): IncomeDomainError {
  return new IncomeDomainError(
    "PERSISTENCE_ERROR",
    "Income could not be deleted.",
  );
}

function centsToSafeNumber(cents: bigint, fieldName: string): number {
  const absolute = cents < BigInt(0) ? -cents : cents;
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IncomeDomainError(
      "PERSISTENCE_ERROR",
      `${fieldName} exceeds the safe numeric range.`,
    );
  }
  return Number(cents) / 100;
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

export async function updateIncome(
  context: IncomeServiceContext,
  incomeId: string,
  input: IncomeUpdateInput,
): Promise<Income> {
  try {
    validateIncomeUuid(context.householdId, "context.householdId");
    validateIncomeUuid(incomeId, "incomeId");
    validateIncomeUpdateInput(input);

    if (
      input.memberId !== undefined &&
      !(await isIncomeMemberInHousehold(context.householdId, input.memberId))
    ) {
      throw new IncomeDomainError(
        "HOUSEHOLD_MISMATCH",
        "The selected member does not belong to the current household.",
      );
    }

    if (
      input.categoryId !== undefined &&
      input.categoryId !== null &&
      !(await isIncomeCategoryAvailable(input.categoryId))
    ) {
      throw new IncomeDomainError(
        "NOT_FOUND",
        "The selected category was not found.",
      );
    }

    const persistenceInput: IncomeUpdatePersistenceInput = {
      householdId: context.householdId,
      incomeId,
    };

    if (input.memberId !== undefined) {
      persistenceInput.memberId = input.memberId;
    }
    if (input.amount !== undefined) {
      persistenceInput.amount = input.amount;
    }
    if (input.incomeDate !== undefined) {
      persistenceInput.incomeDate = input.incomeDate;
    }
    if (input.description !== undefined) {
      persistenceInput.description = input.description;
    }
    if (input.categoryId !== undefined) {
      persistenceInput.categoryId = input.categoryId;
    }

    return await updateIncomeInRepository(persistenceInput);
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      throw error;
    }

    if (error instanceof IncomeRepositoryError) {
      if (error.kind === "NOT_FOUND") {
        throw new IncomeDomainError(
          "NOT_FOUND",
          "Income was not found in the current household.",
        );
      }

      if (error.kind === "INTEGRITY") {
        throw new IncomeDomainError(
          "VALIDATION_ERROR",
          "Income data is no longer valid for update.",
        );
      }
    }

    throw updatePersistenceError();
  }
}

export async function deleteIncome(
  context: IncomeServiceContext,
  incomeId: string,
): Promise<IncomeDeleteResult> {
  try {
    validateIncomeUuid(context.householdId, "context.householdId");
    validateIncomeUuid(incomeId, "incomeId");

    const deletedId = await deleteIncomeInRepository({
      householdId: context.householdId,
      incomeId,
    });

    return { id: deletedId, result: "DELETED" };
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      throw error;
    }

    if (error instanceof IncomeRepositoryError && error.kind === "NOT_FOUND") {
      throw new IncomeDomainError(
        "NOT_FOUND",
        "Income was not found in the current household.",
      );
    }

    throw deletePersistenceError();
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
        totalIncome: centsToSafeNumber(totalIncomeCents, "totalIncome"),
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
