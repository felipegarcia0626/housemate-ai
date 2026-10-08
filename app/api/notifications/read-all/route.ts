import {
  markAllNotificationsAsRead,
  NotificationApplicationUserNotFoundError,
  NotificationRepositoryError,
  SupabaseAuthError,
} from "@/modules/notifications/notification.service";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text();
    if (rawBody.trim() !== "") {
      let body: unknown;
      try { body = JSON.parse(rawBody); } catch { return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida."); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    }
    const updatedCount = await markAllNotificationsAsRead();
    return Response.json({ data: { updatedCount } });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return errorResponse(401, "UNAUTHENTICATED", "Se requiere una sesión autenticada.");
    if (error instanceof NotificationApplicationUserNotFoundError) return errorResponse(403, "APPLICATION_USER_NOT_FOUND", "La identidad autenticada no tiene acceso a la aplicación.");
    if (error instanceof NotificationRepositoryError) return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
    return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
  }
}
