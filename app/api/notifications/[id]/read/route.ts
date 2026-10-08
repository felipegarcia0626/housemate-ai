import { isUUID } from "@/modules/notifications/notification.api-helpers";
import {
  markNotificationAsRead,
  NotificationApplicationUserNotFoundError,
  NotificationNotFoundError,
  NotificationRepositoryError,
  SupabaseAuthError,
} from "@/modules/notifications/notification.service";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    if (!isUUID(id)) return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    const notification = await markNotificationAsRead(id);
    return Response.json({ data: { id: notification.id, readAt: notification.readAt } });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return errorResponse(401, "UNAUTHENTICATED", "Se requiere una sesión autenticada.");
    if (error instanceof NotificationApplicationUserNotFoundError) return errorResponse(403, "APPLICATION_USER_NOT_FOUND", "La identidad autenticada no tiene acceso a la aplicación.");
    if (error instanceof NotificationNotFoundError) return errorResponse(404, "NOT_FOUND", "La notificación no existe.");
    if (error instanceof NotificationRepositoryError) return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
    return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
  }
}
