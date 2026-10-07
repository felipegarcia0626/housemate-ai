export const notificationTypes = [
  "HOUSEHOLD_INVITATION_RECEIVED",
  "HOUSEHOLD_INVITATION_ACCEPTED",
  "HOUSEHOLD_MEMBER_REMOVED",
  "HOUSEHOLD_MEMBER_LEFT",
  "HOUSEHOLD_OWNERSHIP_TRANSFERRED",
] as const;

export type NotificationType = (typeof notificationTypes)[number];

type NotificationEventBase<T extends NotificationType, S extends "INVITATION" | "MEMBERSHIP"> = {
  type: T;
  householdId: string;
  householdName: string;
  actorMemberId: string;
  deduplicationKey: string;
  sourceEntityType: S;
  sourceEntityId: string;
};

export type HouseholdInvitationReceivedEvent = NotificationEventBase<
  "HOUSEHOLD_INVITATION_RECEIVED",
  "INVITATION"
> & {
  metadata: {
    invitationId: string;
    inviterMemberId: string;
    recipientUserId?: string;
  };
};

export type HouseholdInvitationAcceptedEvent = NotificationEventBase<
  "HOUSEHOLD_INVITATION_ACCEPTED",
  "INVITATION"
> & {
  metadata: {
    invitationId: string;
    acceptedMemberId: string;
    acceptedUserId: string;
  };
};

export type HouseholdMemberRemovedEvent = NotificationEventBase<
  "HOUSEHOLD_MEMBER_REMOVED",
  "MEMBERSHIP"
> & {
  metadata: {
    removedMemberId: string;
    removedUserId: string;
  };
};

export type HouseholdMemberLeftEvent = NotificationEventBase<
  "HOUSEHOLD_MEMBER_LEFT",
  "MEMBERSHIP"
> & {
  metadata: {
    leftMemberId: string;
    leftUserId: string;
  };
};

export type HouseholdOwnershipTransferredEvent = NotificationEventBase<
  "HOUSEHOLD_OWNERSHIP_TRANSFERRED",
  "MEMBERSHIP"
> & {
  metadata: {
    previousOwnerMemberId: string;
    previousOwnerUserId: string;
    newOwnerMemberId: string;
    newOwnerUserId: string;
  };
};

export type HouseholdNotificationEvent =
  | HouseholdInvitationReceivedEvent
  | HouseholdInvitationAcceptedEvent
  | HouseholdMemberRemovedEvent
  | HouseholdMemberLeftEvent
  | HouseholdOwnershipTransferredEvent;
