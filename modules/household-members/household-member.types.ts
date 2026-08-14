export interface HouseholdMember {
  id: string;
  displayName: string;
}

export interface HouseholdMemberServiceContext {
  householdId: string;
}

export type HouseholdMemberDomainErrorCode =
  "VALIDATION_ERROR" | "PERSISTENCE_ERROR";

export class HouseholdMemberDomainError extends Error {
  readonly code: HouseholdMemberDomainErrorCode;

  constructor(code: HouseholdMemberDomainErrorCode, message: string) {
    super(message);
    this.name = "HouseholdMemberDomainError";
    this.code = code;
  }
}
