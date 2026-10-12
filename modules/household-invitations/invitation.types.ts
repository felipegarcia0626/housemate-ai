export type HouseholdInvitationStatus = "PENDING" | "ACCEPTED";

export interface CreatedHouseholdInvitation {
  status: "PENDING";
  invitationId: string;
}

export type InvitationCreationResult =
  | (CreatedHouseholdInvitation & { outcome: "CREATED" })
  | { outcome: "RECOVERED"; status: HouseholdInvitationStatus; invitationId: string };

export type InvitationCreationResponse =
  | (CreatedHouseholdInvitation & { outcome: "CREATED"; inviteUrl: string })
  | { outcome: "RECOVERED"; status: HouseholdInvitationStatus; invitationId: string };

export interface AcceptedHouseholdInvitation {
  status: "ACCEPTED";
  alreadyAccepted: boolean;
  householdId: string;
  memberId: string;
}
