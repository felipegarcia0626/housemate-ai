import {
  getSharingRuleHouseholdMemberIds,
  listSharingRules as listInRepository,
  SharingRuleRepositoryError,
} from "./sharing-rule.repository";
import { calculateSplitAmounts } from "./split-calculator";
import {
  SharingRuleDomainError,
  type CalculateSplitInput,
  type CalculateSplitResult,
  type SharingRule,
  type SharingRuleServiceContext,
} from "./sharing-rule.types";
import {
  validateCalculateSplitInput,
  validateSharingRuleUuid,
} from "./sharing-rule.validation";
function persistenceError(): SharingRuleDomainError {
  return new SharingRuleDomainError(
    "PERSISTENCE_ERROR",
    "Sharing Rules could not be loaded.",
  );
}
export async function listSharingRules(
  context: SharingRuleServiceContext,
): Promise<SharingRule[]> {
  try {
    validateSharingRuleUuid(context.householdId, "context.householdId");
    return await listInRepository(context.householdId);
  } catch (error) {
    if (error instanceof SharingRuleDomainError) throw error;
    throw persistenceError();
  }
}
export async function calculateSplit(
  context: SharingRuleServiceContext,
  input: CalculateSplitInput,
): Promise<CalculateSplitResult> {
  try {
    validateSharingRuleUuid(context.householdId, "context.householdId");
    const validated = validateCalculateSplitInput(input);
    const members = await getSharingRuleHouseholdMemberIds(
      context.householdId,
      input.splits.map((split) => split.memberId),
    );
    if (
      input.splits.some((split) => !members.has(split.memberId.toLowerCase()))
    )
      throw new SharingRuleDomainError(
        "HOUSEHOLD_MISMATCH",
        "One or more selected members do not belong to the current household.",
      );
    return {
      amount: input.amount,
      splits: calculateSplitAmounts(
        validated.amountCents,
        input.splits,
        validated.percentageBasisPoints,
      ),
    };
  } catch (error) {
    if (error instanceof SharingRuleDomainError) throw error;
    if (error instanceof SharingRuleRepositoryError)
      throw new SharingRuleDomainError(
        "PERSISTENCE_ERROR",
        "The split could not be calculated.",
      );
    throw new SharingRuleDomainError(
      "PERSISTENCE_ERROR",
      "The split could not be calculated.",
    );
  }
}
