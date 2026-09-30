import {
  getAuthenticatedAuthUser,
  SupabaseAuthError,
} from "@/infrastructure/auth/supabase-server.client";
import {
  AuthenticatedContextRepositoryError,
  findActiveMembershipsByUserId,
  findApplicationUserByAuthUserId,
  type ActiveMembershipRecord,
  type ApplicationUserRecord,
} from "./authenticated-context.repository";
import {
  AuthenticatedContextError,
  type AuthenticatedContext,
} from "./authenticated-context.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthenticatedContextDependencies {
  getAuthenticatedAuthUser: () => Promise<{ id: string } | null>;
  findApplicationUserByAuthUserId: (
    authUserId: string,
  ) => Promise<ApplicationUserRecord | null>;
  findActiveMembershipsByUserId: (
    userId: string,
  ) => Promise<ActiveMembershipRecord[]>;
}

const defaultDependencies: AuthenticatedContextDependencies = {
  getAuthenticatedAuthUser,
  findApplicationUserByAuthUserId,
  findActiveMembershipsByUserId,
};

function contextError(
  code: AuthenticatedContextError["code"],
): AuthenticatedContextError {
  const messages: Record<AuthenticatedContextError["code"], string> = {
    UNAUTHENTICATED: "An authenticated user is required.",
    AUTH_PROVIDER_ERROR: "Authentication could not be verified.",
    APPLICATION_USER_NOT_FOUND:
      "The authenticated user is not linked to an application user.",
    NO_ACTIVE_MEMBERSHIP:
      "The authenticated user has no active household membership.",
    HOUSEHOLD_SELECTION_REQUIRED:
      "The authenticated user must select a household.",
    PERSISTENCE_ERROR: "The authenticated application context is unavailable.",
  };

  return new AuthenticatedContextError(code, messages[code]);
}

export async function resolveAuthenticatedContext(
  dependencies: AuthenticatedContextDependencies = defaultDependencies,
): Promise<Readonly<AuthenticatedContext>> {
  let authUser: { id: string } | null;

  try {
    authUser = await dependencies.getAuthenticatedAuthUser();
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      throw contextError(error.code);
    }
    throw contextError("AUTH_PROVIDER_ERROR");
  }

  if (!authUser || !UUID_PATTERN.test(authUser.id)) {
    throw contextError("UNAUTHENTICATED");
  }

  let applicationUser: ApplicationUserRecord | null;
  try {
    applicationUser = await dependencies.findApplicationUserByAuthUserId(
      authUser.id,
    );
  } catch (error) {
    if (error instanceof AuthenticatedContextRepositoryError) {
      throw contextError("PERSISTENCE_ERROR");
    }
    throw contextError("PERSISTENCE_ERROR");
  }

  if (!applicationUser) {
    throw contextError("APPLICATION_USER_NOT_FOUND");
  }

  let memberships: ActiveMembershipRecord[];
  try {
    memberships = await dependencies.findActiveMembershipsByUserId(
      applicationUser.id,
    );
  } catch (error) {
    if (error instanceof AuthenticatedContextRepositoryError) {
      throw contextError("PERSISTENCE_ERROR");
    }
    throw contextError("PERSISTENCE_ERROR");
  }

  if (memberships.length === 0) {
    throw contextError("NO_ACTIVE_MEMBERSHIP");
  }

  if (memberships.length > 1) {
    throw new AuthenticatedContextError(
      "HOUSEHOLD_SELECTION_REQUIRED",
      "The authenticated user must select a household.",
      memberships.length,
    );
  }

  const [membership] = memberships;

  return Object.freeze({
    authUserId: authUser.id,
    userId: applicationUser.id,
    householdId: membership.householdId,
    memberId: membership.memberId,
    source: "web" as const,
  });
}
