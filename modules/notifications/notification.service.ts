import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { findActiveMembershipsByUserId, findApplicationUserByAuthUserId } from "@/modules/context/authenticated-context.repository";
import {
  countUnreadNotifications,
  createNotification as createNotificationInRepository,
  listNotifications as listNotificationsInRepository,
  markAllNotificationsAsRead as markAllInRepository,
  markNotificationAsRead as markOneInRepository,
  NotificationRepositoryError,
  type NotificationCreateInput,
  type NotificationCursor,
  type NotificationRecord,
} from "./notification.repository";

export class NotificationApplicationUserNotFoundError extends Error {
  constructor() {
    super("The authenticated application user was not found.");
    this.name = "NotificationApplicationUserNotFoundError";
  }
}

export class NotificationForbiddenError extends Error {
  constructor() {
    super("The authenticated user is not allowed to access these notifications.");
    this.name = "NotificationForbiddenError";
  }
}

export class NotificationNotFoundError extends Error {
  constructor() {
    super("Notification was not found.");
    this.name = "NotificationNotFoundError";
  }
}

async function authenticatedApplicationUser(): Promise<{ authUserId: string; userId: string }> {
  const authUser = await getAuthenticatedAuthUser();
  const applicationUser = await findApplicationUserByAuthUserId(authUser.id);
  if (!applicationUser) throw new NotificationApplicationUserNotFoundError();
  return { authUserId: authUser.id, userId: applicationUser.id };
}

async function validateHouseholdAccess(userId: string, householdId?: string): Promise<void> {
  if (!householdId) return;
  const memberships = await findActiveMembershipsByUserId(userId);
  if (!memberships.some((membership) => membership.householdId === householdId)) {
    throw new NotificationForbiddenError();
  }
}

export async function listNotifications(input: {
  householdId?: string;
  limit?: number;
  cursor?: NotificationCursor;
  unreadOnly?: boolean;
}): Promise<{ notifications: NotificationRecord[]; unreadCount: number; nextCursor: NotificationCursor | null }> {
  const current = await authenticatedApplicationUser();
  await validateHouseholdAccess(current.userId, input.householdId);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const [page, unreadCount] = await Promise.all([
    listNotificationsInRepository({ recipientUserId: current.userId, householdId: input.householdId, limit, cursor: input.cursor, unreadOnly: input.unreadOnly }),
    countUnreadNotifications({ recipientUserId: current.userId, householdId: input.householdId }),
  ]);
  return { ...page, unreadCount };
}

export async function getUnreadCount(input: { householdId?: string } = {}): Promise<number> {
  const current = await authenticatedApplicationUser();
  await validateHouseholdAccess(current.userId, input.householdId);
  return countUnreadNotifications({ recipientUserId: current.userId, householdId: input.householdId });
}

export async function markNotificationAsRead(notificationId: string): Promise<NotificationRecord> {
  const current = await authenticatedApplicationUser();
  try {
    return await markOneInRepository({ notificationId, recipientUserId: current.userId });
  } catch (error) {
    if (error instanceof NotificationRepositoryError && error.kind === "NOT_FOUND") {
      throw new NotificationNotFoundError();
    }
    throw error;
  }
}

export async function markAllNotificationsAsRead(): Promise<number> {
  const current = await authenticatedApplicationUser();
  return markAllInRepository({ recipientUserId: current.userId });
}

export async function createNotification(input: NotificationCreateInput): Promise<{
  notification: NotificationRecord;
  created: boolean;
}> {
  return createNotificationInRepository(input);
}

export { NotificationRepositoryError, SupabaseAuthError };
