import {
  ContextRepositoryError,
  householdExists,
  memberBelongsToHousehold,
} from "./context.repository";
import {
  ContextDomainError,
  type HttpActorContext,
  type HttpHouseholdContext,
} from "./context.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configurationError(): ContextDomainError {
  return new ContextDomainError(
    "CONFIGURATION_ERROR",
    "The configured HTTP context is unavailable.",
  );
}

function persistenceError(): ContextDomainError {
  return new ContextDomainError(
    "PERSISTENCE_ERROR",
    "The configured HTTP context could not be validated.",
  );
}

function validateConfiguredUuid(value: string | undefined): string {
  if (value === undefined || value.length === 0 || !UUID_PATTERN.test(value)) {
    throw configurationError();
  }

  return value;
}

export async function resolveHouseholdContext(
  configuredHouseholdId: string | undefined,
): Promise<HttpHouseholdContext> {
  const householdId = validateConfiguredUuid(configuredHouseholdId);

  try {
    if (!(await householdExists(householdId))) {
      throw configurationError();
    }

    return { householdId };
  } catch (error) {
    if (error instanceof ContextDomainError) {
      throw error;
    }
    if (error instanceof ContextRepositoryError) {
      throw persistenceError();
    }

    throw persistenceError();
  }
}

export async function resolveActorContext(
  configuredHouseholdId: string | undefined,
  configuredMemberId: string | undefined,
): Promise<HttpActorContext> {
  const householdId = validateConfiguredUuid(configuredHouseholdId);
  const memberId = validateConfiguredUuid(configuredMemberId);

  try {
    if (!(await householdExists(householdId))) {
      throw configurationError();
    }
    if (!(await memberBelongsToHousehold(householdId, memberId))) {
      throw configurationError();
    }

    return { householdId, memberId };
  } catch (error) {
    if (error instanceof ContextDomainError) {
      throw error;
    }
    if (error instanceof ContextRepositoryError) {
      throw persistenceError();
    }

    throw persistenceError();
  }
}
