import { isUUID } from "@/modules/notifications/notification.api-helpers";
import {
  listNotifications,
  NotificationApplicationUserNotFoundError,
  NotificationForbiddenError,
  NotificationRepositoryError,
  SupabaseAuthError,
} from "@/modules/notifications/notification.service";
import type { NotificationCursor } from "@/modules/notifications/notification.repository";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function parseCursor(value: string | null): NotificationCursor | undefined {
  if (value === null) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string" || !isUUID(candidate.id) || Number.isNaN(Date.parse(candidate.createdAt))) throw new Error();
    return { createdAt: candidate.createdAt, id: candidate.id };
  } catch {
    throw new Error("INVALID_CURSOR");
  }
}

function encodeCursor(cursor: NotificationCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url") : null;
}

function project(notification: Awaited<ReturnType<typeof listNotifications>>["notifications"][number]) {
  return {
    id: notification.id,
    householdId: notification.householdId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    metadata: notification.metadata,
    sourceEntityType: notification.sourceEntityType,
    sourceEntityId: notification.sourceEntityId,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    ...(notification.actionState ? { actionState: notification.actionState } : {}),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    for (const key of params.keys()) {
      if (!["limit", "cursor", "householdId", "unreadOnly"].includes(key)) return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    }
    const limitValue = params.get("limit");
    const limit = limitValue === null ? undefined : Number(limitValue);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    const unreadOnlyValue = params.get("unreadOnly");
    if (unreadOnlyValue !== null && unreadOnlyValue !== "true" && unreadOnlyValue !== "false") return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    const householdId = params.get("householdId") ?? undefined;
    if (householdId !== undefined && !isUUID(householdId)) return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    const cursor = parseCursor(params.get("cursor"));
    const result = await listNotifications({ householdId, limit, cursor, unreadOnly: unreadOnlyValue === "true" });
    return Response.json({ data: { notifications: result.notifications.map(project), nextCursor: encodeCursor(result.nextCursor), unreadCount: result.unreadCount } });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_CURSOR") return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return errorResponse(401, "UNAUTHENTICATED", "Se requiere una sesión autenticada.");
    if (error instanceof NotificationApplicationUserNotFoundError) return errorResponse(403, "APPLICATION_USER_NOT_FOUND", "La identidad autenticada no tiene acceso a la aplicación.");
    if (error instanceof NotificationForbiddenError) return errorResponse(403, "FORBIDDEN", "No tienes acceso a estas notificaciones.");
    if (error instanceof NotificationRepositoryError) return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
    return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
  }
}
