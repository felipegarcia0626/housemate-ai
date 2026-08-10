import {
  createExpense as createExpenseInRepository,
  deleteExpense as deleteExpenseInRepository,
  findExpenseById,
  findReceiptForExpenseCreation,
  getExistingCategoryIds,
  getHouseholdMemberIds,
  isHouseholdMemberInHousehold,
  listConfirmedExpenses,
  ExpenseRepositoryError,
  updateExpense as updateExpenseInRepository,
} from "./expense.repository";
import {
  ExpenseCreatedNotHydratedError,
  ExpenseDomainError,
  ExpenseUpdatedNotHydratedError,
  type ExpenseCalculatedDistribution,
  type Expense,
  type ExpenseCreateInput,
  type ExpenseCreateSplitInput,
  type ExpenseDeleteResult,
  type ExpenseListItem,
  type ExpenseReadFilters,
  type ExpenseServiceContext,
  type ExpenseUpdateInput,
} from "./expense.types";
import {
  toExpenseAmountCents,
  validateExpenseCreateInput,
  validateExpenseReadFilters,
  validateExpenseUpdateInput,
  validateUuid,
} from "./expense.validation";

function validateContext(context: ExpenseServiceContext): void {
  validateUuid(context.householdId, "context.householdId");
}

function persistenceError(): ExpenseDomainError {
  return new ExpenseDomainError(
    "PERSISTENCE_ERROR",
    "Expense could not be persisted.",
  );
}

function centsToAmount(cents: bigint): number {
  return Number(cents) / 100;
}

function calculateDistributions(
  totalCents: bigint,
  splits: readonly ExpenseCreateSplitInput[],
  percentageBasisPoints: readonly bigint[],
): ExpenseCalculatedDistribution[] {
  const percentageDenominator = BigInt(10_000);
  const allocations = splits.map((split, index) => {
    const exactNumerator = totalCents * percentageBasisPoints[index];

    return {
      originalIndex: index,
      householdMemberId: split.householdMemberId,
      percentageBasisPoints: percentageBasisPoints[index],
      amountCents: exactNumerator / percentageDenominator,
      remainder: exactNumerator % percentageDenominator,
    };
  });
  const initiallyAllocatedCents = allocations.reduce(
    (total, allocation) => total + allocation.amountCents,
    BigInt(0),
  );
  const residualCents = totalCents - initiallyAllocatedCents;
  const allocationOrder = [...allocations].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }

    const leftMemberId = left.householdMemberId.toLowerCase();
    const rightMemberId = right.householdMemberId.toLowerCase();

    if (leftMemberId === rightMemberId) {
      return 0;
    }

    return leftMemberId < rightMemberId ? -1 : 1;
  });

  for (let index = 0; index < Number(residualCents); index += 1) {
    allocationOrder[index].amountCents += BigInt(1);
  }

  return allocations
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map((allocation) => ({
      householdMemberId: allocation.householdMemberId,
      amount: centsToAmount(allocation.amountCents),
      percentage: Number(allocation.percentageBasisPoints) / 100,
    }));
}

async function createValidatedExpense(
  context: ExpenseServiceContext,
  input: ExpenseCreateInput,
): Promise<Expense> {
  validateContext(context);
  const { totalCents, splitPercentageBasisPoints, items } =
    validateExpenseCreateInput(input);
  const memberIds = [
    input.createdBy,
    input.paidByMemberId,
    ...input.splits.map((split) => split.householdMemberId),
  ];
  const existingMemberIds = await getHouseholdMemberIds(
    context.householdId,
    memberIds,
  );

  if (
    memberIds.some((memberId) => !existingMemberIds.has(memberId.toLowerCase()))
  ) {
    throw new ExpenseDomainError(
      "HOUSEHOLD_MISMATCH",
      "One or more selected members do not belong to the current household.",
    );
  }

  const categoryIds = [
    input.categoryId,
    ...items.map((item) => item.categoryId),
  ].filter((categoryId): categoryId is string => categoryId != null);
  const existingCategoryIds = await getExistingCategoryIds(categoryIds);

  if (
    categoryIds.some(
      (categoryId) => !existingCategoryIds.has(categoryId.toLowerCase()),
    )
  ) {
    throw new ExpenseDomainError(
      "NOT_FOUND",
      "One or more selected categories were not found.",
    );
  }

  const receiptId = input.receiptId ?? null;

  if (receiptId !== null) {
    const receipt = await findReceiptForExpenseCreation(receiptId);

    if (receipt === null) {
      throw new ExpenseDomainError("NOT_FOUND", "Receipt was not found.");
    }

    if (receipt.householdId !== context.householdId) {
      throw new ExpenseDomainError(
        "HOUSEHOLD_MISMATCH",
        "Receipt does not belong to the current household.",
      );
    }

    if (receipt.processingStatus !== "PROCESSED") {
      throw new ExpenseDomainError(
        "VALIDATION_ERROR",
        "Receipt must be processed before it can be associated.",
      );
    }

    if (receipt.expenseId !== null) {
      throw new ExpenseDomainError(
        "VALIDATION_ERROR",
        "Receipt is already associated with an Expense.",
      );
    }
  }

  const distributions = calculateDistributions(
    totalCents,
    input.splits,
    splitPercentageBasisPoints,
  );
  const expenseId = await createExpenseInRepository({
    householdId: context.householdId,
    createdBy: input.createdBy,
    paidByMemberId: input.paidByMemberId,
    categoryId: input.categoryId ?? null,
    receiptId,
    merchant: input.merchant ?? null,
    totalAmount: input.totalAmount,
    expenseDate: input.expenseDate,
    description: input.description ?? null,
    source: input.source,
    items,
    distributions,
  });

  try {
    const expense = await findExpenseById(context.householdId, expenseId);

    if (expense === null) {
      throw new ExpenseCreatedNotHydratedError(expenseId);
    }

    return expense;
  } catch (error) {
    if (error instanceof ExpenseCreatedNotHydratedError) {
      throw error;
    }

    throw new ExpenseCreatedNotHydratedError(expenseId);
  }
}

export async function createExpense(
  context: ExpenseServiceContext,
  input: ExpenseCreateInput,
): Promise<Expense> {
  try {
    return await createValidatedExpense(context, input);
  } catch (error) {
    if (error instanceof ExpenseDomainError) {
      throw error;
    }

    if (error instanceof ExpenseRepositoryError && error.kind === "INTEGRITY") {
      throw new ExpenseDomainError(
        "VALIDATION_ERROR",
        "Expense data is no longer valid for creation.",
      );
    }

    throw persistenceError();
  }
}

async function updateValidatedExpense(
  context: ExpenseServiceContext,
  expenseId: string,
  input: ExpenseUpdateInput,
): Promise<Expense> {
  validateContext(context);
  validateUuid(expenseId, "expenseId");
  const validated = validateExpenseUpdateInput(input);
  const currentExpense = await findExpenseById(context.householdId, expenseId);

  if (currentExpense === null) {
    throw new ExpenseDomainError(
      "NOT_FOUND",
      "Expense was not found in the current household.",
    );
  }

  if (currentExpense.status !== "CONFIRMED") {
    throw new ExpenseDomainError(
      "VALIDATION_ERROR",
      "Only confirmed Expenses can be updated.",
    );
  }

  const currentTotalCents = toExpenseAmountCents(
    currentExpense.totalAmount,
    "currentExpense.totalAmount",
  );
  const effectiveTotalCents = validated.totalCents ?? currentTotalCents;
  const totalAmountChanged =
    validated.totalCents !== undefined &&
    validated.totalCents !== currentTotalCents;

  if (totalAmountChanged && input.splits === undefined) {
    throw new ExpenseDomainError(
      "VALIDATION_ERROR",
      "splits must be provided when totalAmount changes.",
    );
  }

  const effectiveItemsTotalCents =
    validated.itemsTotalCents ??
    currentExpense.items.reduce(
      (total, item, index) =>
        total +
        toExpenseAmountCents(
          item.totalAmount,
          `currentExpense.items[${index}].totalAmount`,
        ),
      BigInt(0),
    );

  if (effectiveItemsTotalCents > effectiveTotalCents) {
    throw new ExpenseDomainError(
      "VALIDATION_ERROR",
      "The sum of item totals cannot exceed totalAmount.",
    );
  }

  const memberIds = [
    input.paidByMemberId,
    ...(input.splits?.map((split) => split.householdMemberId) ?? []),
  ].filter((memberId): memberId is string => memberId !== undefined);
  const existingMemberIds = await getHouseholdMemberIds(
    context.householdId,
    memberIds,
  );

  if (
    memberIds.some((memberId) => !existingMemberIds.has(memberId.toLowerCase()))
  ) {
    throw new ExpenseDomainError(
      "HOUSEHOLD_MISMATCH",
      "One or more selected members do not belong to the current household.",
    );
  }

  const categoryIds = [
    validated.categoryIdIsSet ? input.categoryId : undefined,
    ...(validated.items?.map((item) => item.categoryId) ?? []),
  ].filter((categoryId): categoryId is string => categoryId != null);
  const existingCategoryIds = await getExistingCategoryIds(categoryIds);

  if (
    categoryIds.some(
      (categoryId) => !existingCategoryIds.has(categoryId.toLowerCase()),
    )
  ) {
    throw new ExpenseDomainError(
      "NOT_FOUND",
      "One or more selected categories were not found.",
    );
  }

  const distributions =
    input.splits === undefined ||
    validated.splitPercentageBasisPoints === undefined
      ? null
      : calculateDistributions(
          effectiveTotalCents,
          input.splits,
          validated.splitPercentageBasisPoints,
        );
  const updatedExpenseId = await updateExpenseInRepository({
    householdId: context.householdId,
    expenseId,
    merchantIsSet: validated.merchantIsSet,
    merchant: validated.merchantIsSet ? (input.merchant ?? null) : null,
    descriptionIsSet: validated.descriptionIsSet,
    description: validated.descriptionIsSet
      ? (input.description ?? null)
      : null,
    totalAmount: validated.totalCents === undefined ? null : input.totalAmount!,
    expenseDate: input.expenseDate ?? null,
    paidByMemberId: input.paidByMemberId ?? null,
    categoryIdIsSet: validated.categoryIdIsSet,
    categoryId: validated.categoryIdIsSet ? (input.categoryId ?? null) : null,
    items: validated.items ?? null,
    distributions,
  });

  try {
    const updatedExpense = await findExpenseById(
      context.householdId,
      updatedExpenseId,
    );

    if (updatedExpense === null) {
      throw new ExpenseUpdatedNotHydratedError(updatedExpenseId);
    }

    return updatedExpense;
  } catch (error) {
    if (error instanceof ExpenseUpdatedNotHydratedError) {
      throw error;
    }

    throw new ExpenseUpdatedNotHydratedError(updatedExpenseId);
  }
}

export async function updateExpense(
  context: ExpenseServiceContext,
  expenseId: string,
  input: ExpenseUpdateInput,
): Promise<Expense> {
  try {
    return await updateValidatedExpense(context, expenseId, input);
  } catch (error) {
    if (error instanceof ExpenseDomainError) {
      throw error;
    }

    if (error instanceof ExpenseRepositoryError) {
      if (error.kind === "NOT_FOUND") {
        throw new ExpenseDomainError(
          "NOT_FOUND",
          "Expense was not found in the current household.",
        );
      }

      if (error.kind === "INTEGRITY") {
        throw new ExpenseDomainError(
          "VALIDATION_ERROR",
          "Expense data is no longer valid for update.",
        );
      }
    }

    throw persistenceError();
  }
}

export async function deleteExpense(
  context: ExpenseServiceContext,
  expenseId: string,
): Promise<ExpenseDeleteResult> {
  try {
    validateContext(context);
    validateUuid(expenseId, "expenseId");

    const result = await deleteExpenseInRepository({
      householdId: context.householdId,
      expenseId,
    });

    return { id: expenseId, result };
  } catch (error) {
    if (error instanceof ExpenseDomainError) {
      throw error;
    }

    if (error instanceof ExpenseRepositoryError) {
      if (error.kind === "NOT_FOUND") {
        throw new ExpenseDomainError(
          "NOT_FOUND",
          "Expense was not found in the current household.",
        );
      }

      if (error.kind === "INTEGRITY") {
        throw new ExpenseDomainError(
          "VALIDATION_ERROR",
          "Expense cannot be deleted while related data prevents deletion.",
        );
      }
    }

    throw persistenceError();
  }
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
