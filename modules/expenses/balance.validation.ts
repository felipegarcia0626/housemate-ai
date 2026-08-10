import {
  BalanceDomainError,
  type BalanceServiceContext,
} from "./balance.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateBalanceContext(
  context: unknown,
): asserts context is BalanceServiceContext {
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    throw new BalanceDomainError(
      "VALIDATION_ERROR",
      "Balance context must be an object.",
    );
  }

  if (
    !("householdId" in context) ||
    typeof context.householdId !== "string" ||
    !UUID_PATTERN.test(context.householdId)
  ) {
    throw new BalanceDomainError(
      "VALIDATION_ERROR",
      "context.householdId must be a valid UUID.",
    );
  }
}
