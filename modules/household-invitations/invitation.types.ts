export type HouseholdInvitationStatus = "PENDING" | "ACCEPTED";

export interface CreatedHouseholdInvitation {
  status: "PENDING";
  invitationId: string;
}

export interface AcceptedHouseholdInvitation {
  status: "ACCEPTED";
  alreadyAccepted: boolean;
  householdId: string;
  memberId: string;
}
