export interface BalanceMember {
  memberId: string;
  paid: number;
  share: number;
  balance: number;
}

export interface BalanceResult {
  members: BalanceMember[];
}

export interface BalanceServiceContext {
  householdId: string;
}

export interface BalanceDistributionRecord {
  memberId: string;
  amount: number | string;
}

export interface BalanceExpenseRecord {
  paidByMemberId: string;
  totalAmount: number | string;
  distributions: BalanceDistributionRecord[];
}

export type BalanceDomainErrorCode = "VALIDATION_ERROR" | "PERSISTENCE_ERROR";

export class BalanceDomainError extends Error {
  readonly code: BalanceDomainErrorCode;

  constructor(code: BalanceDomainErrorCode, message: string) {
    super(message);
    this.name = "BalanceDomainError";
    this.code = code;
  }
}
