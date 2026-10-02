import { SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { provisionAuthenticatedUser, ProvisioningError } from "@/modules/onboarding/provisioning.service";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "displayName" && key !== "householdName"))
      return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
    const result = await provisionAuthenticatedUser(body as { displayName: unknown; householdName: unknown });
    return Response.json({ data: result });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED")
      return errorResponse(401, "UNAUTHENTICATED", "Se requiere una sesión autenticada.");
    if (error instanceof ProvisioningError && error.code === "VALIDATION_ERROR")
      return errorResponse(400, error.code, "Solicitud inválida.");
    return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar el onboarding.");
  }
}
