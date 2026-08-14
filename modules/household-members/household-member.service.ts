import {
  HouseholdMemberRepositoryError,
  listHouseholdMembers as listHouseholdMembersInRepository,
} from "./household-member.repository";
import {
  HouseholdMemberDomainError,
  type HouseholdMember,
  type HouseholdMemberServiceContext,
} from "./household-member.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateHouseholdId(householdId: string): void {
  if (!UUID_PATTERN.test(householdId)) {
    throw new HouseholdMemberDomainError(
      "VALIDATION_ERROR",
      "The household context is invalid.",
    );
  }
}

export async function listHouseholdMembers(
  context: HouseholdMemberServiceContext,
): Promise<HouseholdMember[]> {
  try {
    validateHouseholdId(context.householdId);
    return await listHouseholdMembersInRepository(context.householdId);
  } catch (error) {
    if (error instanceof HouseholdMemberDomainError) throw error;
    if (error instanceof HouseholdMemberRepositoryError) {
      throw new HouseholdMemberDomainError(
        "PERSISTENCE_ERROR",
        "Household members could not be loaded.",
      );
    }
    throw new HouseholdMemberDomainError(
      "PERSISTENCE_ERROR",
      "Household members could not be loaded.",
    );
  }
}
