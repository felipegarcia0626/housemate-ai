export interface AuthenticatedContext {
  readonly authUserId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly memberId: string;
  readonly source: "web";
}

export type AuthenticatedContextErrorCode =
  | "UNAUTHENTICATED"
  | "AUTH_PROVIDER_ERROR"
  | "APPLICATION_USER_NOT_FOUND"
  | "NO_ACTIVE_MEMBERSHIP"
  | "HOUSEHOLD_SELECTION_REQUIRED"
  | "PERSISTENCE_ERROR";

export class AuthenticatedContextError extends Error {
  readonly code: AuthenticatedContextErrorCode;
  readonly membershipCount?: number;

  constructor(
    code: AuthenticatedContextErrorCode,
    message: string,
    membershipCount?: number,
  ) {
    super(message);
    this.name = "AuthenticatedContextError";
    this.code = code;
    this.membershipCount = membershipCount;
  }
}
