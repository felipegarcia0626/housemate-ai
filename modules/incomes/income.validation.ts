import {
  IncomeDomainError,
  type IncomeCreateInput,
  type IncomeListFilters,
  type IncomeUpdateInput,
} from "./income.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message: string): never {
  throw new IncomeDomainError("VALIDATION_ERROR", message);
}

export function validateIncomeUuid(value: string, fieldName: string): void {
  if (!UUID_PATTERN.test(value)) {
    validationError(`${fieldName} must be a valid UUID.`);
  }
}

export function validateIncomeIsoDate(value: string, fieldName: string): void {
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

export function validateIncomeListFilters(filters: IncomeListFilters): void {
  if (filters.from !== undefined) {
    validateIncomeIsoDate(filters.from, "from");
  }

  if (filters.to !== undefined) {
    validateIncomeIsoDate(filters.to, "to");
  }

  if (
    filters.from !== undefined &&
    filters.to !== undefined &&
    filters.from > filters.to
  ) {
    validationError("from must be earlier than or equal to to.");
  }

  if (filters.memberId !== undefined) {
    validateIncomeUuid(filters.memberId, "memberId");
  }

  if (filters.categoryId !== undefined) {
    validateIncomeUuid(filters.categoryId, "categoryId");
  }
}

export function validateIncomeCreateInput(input: IncomeCreateInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    validationError("input must be an object.");
  }

  validateIncomeUuid(input.memberId, "memberId");
  validateIncomeIsoDate(input.incomeDate, "incomeDate");

  const amountCents = toIncomeAmountCents(input.amount, "amount");
  if (amountCents <= BigInt(0)) {
    validationError("amount must be greater than zero.");
  }

  if (typeof input.description !== "string") {
    validationError("description must be a string.");
  }

  if (input.categoryId !== undefined && input.categoryId !== null) {
    validateIncomeUuid(input.categoryId, "categoryId");
  }
}

export function validateIncomeUpdateInput(input: IncomeUpdateInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    validationError("input must be an object.");
  }

  if (
    input.memberId === undefined &&
    input.amount === undefined &&
    input.incomeDate === undefined &&
    input.description === undefined &&
    input.categoryId === undefined
  ) {
    validationError("input must include at least one field to update.");
  }

  if (input.memberId !== undefined) {
    validateIncomeUuid(input.memberId, "memberId");
  }

  if (input.amount !== undefined) {
    const amountCents = toIncomeAmountCents(input.amount, "amount");
    if (amountCents <= BigInt(0)) {
      validationError("amount must be greater than zero.");
    }
  }

  if (input.incomeDate !== undefined) {
    validateIncomeIsoDate(input.incomeDate, "incomeDate");
  }

  if (
    input.description !== undefined &&
    typeof input.description !== "string"
  ) {
    validationError("description must be a string.");
  }

  if (input.categoryId !== undefined && input.categoryId !== null) {
    validateIncomeUuid(input.categoryId, "categoryId");
  }
}

export function toIncomeAmountCents(value: number, fieldName: string): bigint {
  if (!Number.isFinite(value) || value < 0) {
    validationError(`${fieldName} must be a non-negative finite number.`);
  }

  const representation = String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(representation);

  if (!match) {
    validationError(
      `${fieldName} must be a decimal amount without exponent notation.`,
    );
  }

  const integerPart = match[1];
  const fractionalPart = match[2] ?? "";

  if (fractionalPart.length > 2) {
    validationError(`${fieldName} supports at most two decimal places.`);
  }

  const scaled = `${integerPart}${fractionalPart.padEnd(2, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );

  if (scaled.length > 14) {
    validationError(`${fieldName} exceeds the supported precision.`);
  }

  return BigInt(scaled);
}
