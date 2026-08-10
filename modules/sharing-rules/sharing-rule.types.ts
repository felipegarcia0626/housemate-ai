export interface SharingRuleSplit {
  memberId: string;
  percentage: number;
}
export interface SharingRule {
  id: string;
  name: string;
  type: "PERCENTAGE";
  splits: SharingRuleSplit[];
}
export interface SharingRuleServiceContext {
  householdId: string;
}
export interface CalculateSplitInput {
  amount: number;
  splits: SharingRuleSplit[];
}
export interface CalculatedSplit extends SharingRuleSplit {
  amount: number;
}
export interface CalculateSplitResult {
  amount: number;
  splits: CalculatedSplit[];
}
export type SharingRuleDomainErrorCode =
  "VALIDATION_ERROR" | "HOUSEHOLD_MISMATCH" | "PERSISTENCE_ERROR";
export class SharingRuleDomainError extends Error {
  readonly code: SharingRuleDomainErrorCode;
  constructor(code: SharingRuleDomainErrorCode, message: string) {
    super(message);
    this.name = "SharingRuleDomainError";
    this.code = code;
  }
}
