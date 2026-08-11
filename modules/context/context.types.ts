export interface HttpHouseholdContext {
  householdId: string;
}

export interface HttpActorContext extends HttpHouseholdContext {
  memberId: string;
}

export type ContextDomainErrorCode =
  "CONFIGURATION_ERROR" | "PERSISTENCE_ERROR";

export class ContextDomainError extends Error {
  readonly code: ContextDomainErrorCode;

  constructor(code: ContextDomainErrorCode, message: string) {
    super(message);
    this.name = "ContextDomainError";
    this.code = code;
  }
}
