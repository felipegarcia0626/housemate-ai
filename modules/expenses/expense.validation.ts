import { ExpenseDomainError, type ExpenseReadFilters } from "./expense.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message: string): never {
  throw new ExpenseDomainError("VALIDATION_ERROR", message);
}

export function validateUuid(value: string, fieldName: string): void {
  if (!UUID_PATTERN.test(value)) {
    validationError(`${fieldName} must be a valid UUID.`);
  }
}

export function validateIsoDate(value: string, fieldName: string): void {
  if (!ISO_DATE_PATTERN.test(value)) {
    validationError(`${fieldName} must use the YYYY-MM-DD format.`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    validationError(`${fieldName} must be a valid date.`);
  }
}

function validateAmount(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    validationError(`${fieldName} must be a non-negative finite number.`);
  }
}

export function validateExpenseReadFilters(filters: ExpenseReadFilters): void {
  if (filters.from !== undefined) {
    validateIsoDate(filters.from, "from");
  }

  if (filters.to !== undefined) {
    validateIsoDate(filters.to, "to");
  }

  if (
    filters.from !== undefined &&
    filters.to !== undefined &&
    filters.from > filters.to
  ) {
    validationError("from must be earlier than or equal to to.");
  }

  if (filters.categoryId !== undefined) {
    validateUuid(filters.categoryId, "categoryId");
  }

  if (filters.memberId !== undefined) {
    validateUuid(filters.memberId, "memberId");
  }

  if (filters.minAmount !== undefined) {
    validateAmount(filters.minAmount, "minAmount");
  }

  if (filters.maxAmount !== undefined) {
    validateAmount(filters.maxAmount, "maxAmount");
  }

  if (
    filters.minAmount !== undefined &&
    filters.maxAmount !== undefined &&
    filters.minAmount > filters.maxAmount
  ) {
    validationError("minAmount must be less than or equal to maxAmount.");
  }
}
