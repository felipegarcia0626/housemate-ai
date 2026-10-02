import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { AuthenticatedContextRepositoryError, findApplicationUserByAuthUserId, findActiveMembershipsByUserId } from "@/modules/context/authenticated-context.repository";
import { setSelectedWebHouseholdId, clearSelectedWebHouseholdId } from "@/infrastructure/auth/web-household-selection";

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || typeof body.householdId !== "string" || Object.keys(body).some((key) => key !== "householdId"))
      return errorResponse(422, "VALIDATION_ERROR", "Solicitud inválida.");
    const authUser = await getAuthenticatedAuthUser();
    const user = await findApplicationUserByAuthUserId(authUser.id);
    if (!user) return errorResponse(403, "APPLICATION_USER_NOT_FOUND", "La identidad autenticada no tiene acceso a la aplicación.");
    const membership = (await findActiveMembershipsByUserId(user.id)).find((item) => item.householdId === body.householdId);
    if (!membership) return errorResponse(403, "FORBIDDEN", "No tienes acceso a ese hogar.");
    await setSelectedWebHouseholdId(membership.householdId);
    return Response.json({ data: { householdId: membership.householdId } });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return errorResponse(401, "UNAUTHENTICATED", "Se requiere una sesión autenticada.");
    if (error instanceof SupabaseAuthError) return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
    if (error instanceof AuthenticatedContextRepositoryError) return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
    return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
  }
}

export async function DELETE(): Promise<Response> {
  await clearSelectedWebHouseholdId();
  return new Response(null, { status: 204 });
}
