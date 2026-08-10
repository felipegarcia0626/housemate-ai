import {
  DashboardDomainError,
  type DashboardFilters,
  type DashboardServiceContext,
} from "./dashboard.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message: string): never {
  throw new DashboardDomainError("VALIDATION_ERROR", message);
}

function validateIsoDate(value: string, fieldName: string): void {
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

export function validateDashboardContext(
  context: unknown,
): asserts context is DashboardServiceContext {
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    validationError("Dashboard context must be an object.");
  }

  if (
    !("householdId" in context) ||
    typeof context.householdId !== "string" ||
    !UUID_PATTERN.test(context.householdId)
  ) {
    validationError("context.householdId must be a valid UUID.");
  }
}

export function validateDashboardFilters(
  filters: unknown,
): asserts filters is DashboardFilters {
  if (
    typeof filters !== "object" ||
    filters === null ||
    Array.isArray(filters)
  ) {
    validationError("Dashboard filters must be an object.");
  }

  const allowedKeys = new Set(["from", "to"]);
  for (const key of Object.keys(filters)) {
    if (!allowedKeys.has(key)) {
      validationError(`${key} is not a supported Dashboard filter.`);
    }
  }

  if ("from" in filters && filters.from !== undefined) {
    if (typeof filters.from !== "string") {
      validationError("from must be a string.");
    }
    validateIsoDate(filters.from, "from");
  }

  if ("to" in filters && filters.to !== undefined) {
    if (typeof filters.to !== "string") {
      validationError("to must be a string.");
    }
    validateIsoDate(filters.to, "to");
  }

  const from = "from" in filters ? filters.from : undefined;
  const to = "to" in filters ? filters.to : undefined;
  if (typeof from === "string" && typeof to === "string" && from > to) {
    validationError("from must be earlier than or equal to to.");
  }
}
