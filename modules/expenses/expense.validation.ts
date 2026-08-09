import {
  ExpenseDomainError,
  type ExpenseCreateItemInput,
  type ExpenseCreateInput,
  type ExpenseReadFilters,
  type ExpenseUpdateInput,
} from "./expense.types";

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

function toScaledInteger(
  value: number,
  scale: number,
  precision: number,
  fieldName: string,
): bigint {
  if (!Number.isFinite(value)) {
    validationError(`${fieldName} must be a finite number.`);
  }

  const representation = String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(representation);

  if (!match) {
    validationError(
      `${fieldName} must be a non-negative decimal without exponent notation.`,
    );
  }

  const integerPart = match[1];
  const fractionalPart = match[2] ?? "";

  if (fractionalPart.length > scale) {
    validationError(`${fieldName} supports at most ${scale} decimal places.`);
  }

  const scaledRepresentation =
    `${integerPart}${fractionalPart.padEnd(scale, "0")}`.replace(
      /^0+(?=\d)/,
      "",
    );

  if (scaledRepresentation.length > precision) {
    validationError(`${fieldName} exceeds the supported precision.`);
  }

  return BigInt(scaledRepresentation);
}

function validateNullableText(
  value: string | null | undefined,
  fieldName: string,
  rejectEmpty: boolean,
): void {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "string" || (rejectEmpty && value.trim().length === 0)) {
    validationError(`${fieldName} must be a non-empty string or null.`);
  }
}

export function validateExpenseCreateInput(input: ExpenseCreateInput): {
  totalCents: bigint;
  splitPercentageBasisPoints: bigint[];
  items: ExpenseCreateItemInput[];
} {
  validateUuid(input.createdBy, "createdBy");
  validateUuid(input.paidByMemberId, "paidByMemberId");
  validateIsoDate(input.expenseDate, "expenseDate");

  if (
    input.source !== "WEB" &&
    input.source !== "WHATSAPP" &&
    input.source !== "RECEIPT"
  ) {
    validationError("source must be WEB, WHATSAPP or RECEIPT.");
  }

  if (input.categoryId !== undefined && input.categoryId !== null) {
    validateUuid(input.categoryId, "categoryId");
  }

  if (input.receiptId !== undefined && input.receiptId !== null) {
    validateUuid(input.receiptId, "receiptId");
  }

  validateNullableText(input.merchant, "merchant", true);
  validateNullableText(input.description, "description", false);

  const totalCents = toScaledInteger(input.totalAmount, 2, 14, "totalAmount");

  if (totalCents <= BigInt(0)) {
    validationError("totalAmount must be greater than zero.");
  }

  const items = input.items ?? [];

  if (!Array.isArray(items)) {
    validationError("items must be an array.");
  }

  let itemsTotalCents = BigInt(0);

  items.forEach((item, index) => {
    const fieldPrefix = `items[${index}]`;

    if (typeof item !== "object" || item === null) {
      validationError(`${fieldPrefix} must be an object.`);
    }

    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      validationError(`${fieldPrefix}.name must be a non-empty string.`);
    }

    const itemTotalCents = toScaledInteger(
      item.totalAmount,
      2,
      14,
      `${fieldPrefix}.totalAmount`,
    );

    if (itemTotalCents <= BigInt(0)) {
      validationError(`${fieldPrefix}.totalAmount must be greater than zero.`);
    }

    itemsTotalCents += itemTotalCents;

    if (item.quantity !== undefined && item.quantity !== null) {
      const quantity = toScaledInteger(
        item.quantity,
        3,
        12,
        `${fieldPrefix}.quantity`,
      );

      if (quantity <= BigInt(0)) {
        validationError(`${fieldPrefix}.quantity must be greater than zero.`);
      }
    }

    if (item.unitPrice !== undefined && item.unitPrice !== null) {
      toScaledInteger(item.unitPrice, 2, 14, `${fieldPrefix}.unitPrice`);
    }

    if (item.categoryId !== undefined && item.categoryId !== null) {
      validateUuid(item.categoryId, `${fieldPrefix}.categoryId`);
    }
  });

  if (itemsTotalCents > totalCents) {
    validationError("The sum of item totals cannot exceed totalAmount.");
  }

  if (!Array.isArray(input.splits) || input.splits.length === 0) {
    validationError("splits must be a non-empty array.");
  }

  const seenMemberIds = new Set<string>();
  const splitPercentageBasisPoints = input.splits.map((split, index) => {
    const fieldPrefix = `splits[${index}]`;

    if (typeof split !== "object" || split === null) {
      validationError(`${fieldPrefix} must be an object.`);
    }

    validateUuid(split.householdMemberId, `${fieldPrefix}.householdMemberId`);

    const normalizedMemberId = split.householdMemberId.toLowerCase();

    if (seenMemberIds.has(normalizedMemberId)) {
      validationError("splits cannot contain duplicate household members.");
    }

    seenMemberIds.add(normalizedMemberId);

    const percentageBasisPoints = toScaledInteger(
      split.percentage,
      2,
      5,
      `${fieldPrefix}.percentage`,
    );

    if (percentageBasisPoints > BigInt(10_000)) {
      validationError(`${fieldPrefix}.percentage must be between 0 and 100.`);
    }

    return percentageBasisPoints;
  });

  const percentageTotal = splitPercentageBasisPoints.reduce(
    (total, percentage) => total + percentage,
    BigInt(0),
  );

  if (percentageTotal !== BigInt(10_000)) {
    validationError("split percentages must sum exactly to 100.00.");
  }

  return { totalCents, splitPercentageBasisPoints, items };
}

export function toExpenseAmountCents(value: number, fieldName: string): bigint {
  return toScaledInteger(value, 2, 14, fieldName);
}

export function validateExpenseUpdateInput(input: ExpenseUpdateInput): {
  merchantIsSet: boolean;
  descriptionIsSet: boolean;
  categoryIdIsSet: boolean;
  totalCents: bigint | undefined;
  items: ExpenseCreateItemInput[] | undefined;
  itemsTotalCents: bigint | undefined;
  splitPercentageBasisPoints: bigint[] | undefined;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    validationError("input must be an object.");
  }

  const allowedFields = new Set([
    "merchant",
    "description",
    "totalAmount",
    "expenseDate",
    "paidByMemberId",
    "categoryId",
    "items",
    "splits",
  ]);
  const inputFields = Object.keys(input);

  if (inputFields.length === 0) {
    validationError("At least one field must be provided for update.");
  }

  if (inputFields.some((field) => !allowedFields.has(field))) {
    validationError("The update contains an unsupported field.");
  }

  const merchantIsSet = Object.hasOwn(input, "merchant");
  const descriptionIsSet = Object.hasOwn(input, "description");
  const categoryIdIsSet = Object.hasOwn(input, "categoryId");

  if (merchantIsSet) {
    if (input.merchant === undefined) {
      validationError("merchant must be a string or null.");
    }

    validateNullableText(input.merchant, "merchant", true);
  }

  if (descriptionIsSet) {
    if (input.description === undefined) {
      validationError("description must be a string or null.");
    }

    validateNullableText(input.description, "description", false);
  }

  if (Object.hasOwn(input, "expenseDate") && input.expenseDate !== undefined) {
    validateIsoDate(input.expenseDate, "expenseDate");
  } else if (Object.hasOwn(input, "expenseDate")) {
    validationError("expenseDate must be provided when the field is present.");
  }

  if (
    Object.hasOwn(input, "paidByMemberId") &&
    input.paidByMemberId !== undefined
  ) {
    validateUuid(input.paidByMemberId, "paidByMemberId");
  } else if (Object.hasOwn(input, "paidByMemberId")) {
    validationError(
      "paidByMemberId must be provided when the field is present.",
    );
  }

  if (categoryIdIsSet && input.categoryId !== null) {
    if (input.categoryId === undefined) {
      validationError("categoryId must be a UUID or null.");
    }

    validateUuid(input.categoryId, "categoryId");
  }

  let totalCents: bigint | undefined;

  if (Object.hasOwn(input, "totalAmount")) {
    if (input.totalAmount === undefined) {
      validationError(
        "totalAmount must be provided when the field is present.",
      );
    }

    totalCents = toScaledInteger(input.totalAmount, 2, 14, "totalAmount");

    if (totalCents <= BigInt(0)) {
      validationError("totalAmount must be greater than zero.");
    }
  }

  let items: ExpenseCreateItemInput[] | undefined;
  let itemsTotalCents: bigint | undefined;

  if (Object.hasOwn(input, "items")) {
    if (!Array.isArray(input.items)) {
      validationError("items must be an array.");
    }

    items = input.items;
    let replacementItemsTotalCents = BigInt(0);

    items.forEach((item, index) => {
      const fieldPrefix = `items[${index}]`;

      if (typeof item !== "object" || item === null) {
        validationError(`${fieldPrefix} must be an object.`);
      }

      if (typeof item.name !== "string" || item.name.trim().length === 0) {
        validationError(`${fieldPrefix}.name must be a non-empty string.`);
      }

      const itemTotalCents = toScaledInteger(
        item.totalAmount,
        2,
        14,
        `${fieldPrefix}.totalAmount`,
      );

      if (itemTotalCents <= BigInt(0)) {
        validationError(
          `${fieldPrefix}.totalAmount must be greater than zero.`,
        );
      }

      replacementItemsTotalCents += itemTotalCents;

      if (item.quantity !== undefined && item.quantity !== null) {
        const quantity = toScaledInteger(
          item.quantity,
          3,
          12,
          `${fieldPrefix}.quantity`,
        );

        if (quantity <= BigInt(0)) {
          validationError(`${fieldPrefix}.quantity must be greater than zero.`);
        }
      }

      if (item.unitPrice !== undefined && item.unitPrice !== null) {
        toScaledInteger(item.unitPrice, 2, 14, `${fieldPrefix}.unitPrice`);
      }

      if (item.categoryId !== undefined && item.categoryId !== null) {
        validateUuid(item.categoryId, `${fieldPrefix}.categoryId`);
      }
    });

    itemsTotalCents = replacementItemsTotalCents;
  }

  let splitPercentageBasisPoints: bigint[] | undefined;

  if (Object.hasOwn(input, "splits")) {
    if (!Array.isArray(input.splits) || input.splits.length === 0) {
      validationError("splits must be a non-empty array when provided.");
    }

    const seenMemberIds = new Set<string>();
    splitPercentageBasisPoints = input.splits.map((split, index) => {
      const fieldPrefix = `splits[${index}]`;

      if (typeof split !== "object" || split === null) {
        validationError(`${fieldPrefix} must be an object.`);
      }

      validateUuid(split.householdMemberId, `${fieldPrefix}.householdMemberId`);
      const normalizedMemberId = split.householdMemberId.toLowerCase();

      if (seenMemberIds.has(normalizedMemberId)) {
        validationError("splits cannot contain duplicate household members.");
      }

      seenMemberIds.add(normalizedMemberId);
      const percentageBasisPoints = toScaledInteger(
        split.percentage,
        2,
        5,
        `${fieldPrefix}.percentage`,
      );

      if (percentageBasisPoints > BigInt(10_000)) {
        validationError(`${fieldPrefix}.percentage must be between 0 and 100.`);
      }

      return percentageBasisPoints;
    });

    const percentageTotal = splitPercentageBasisPoints.reduce(
      (total, percentage) => total + percentage,
      BigInt(0),
    );

    if (percentageTotal !== BigInt(10_000)) {
      validationError("split percentages must sum exactly to 100.00.");
    }
  }

  return {
    merchantIsSet,
    descriptionIsSet,
    categoryIdIsSet,
    totalCents,
    items,
    itemsTotalCents,
    splitPercentageBasisPoints,
  };
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
