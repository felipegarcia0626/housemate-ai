import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import {
  AuthenticatedContextRepositoryError,
  findApplicationUserByAuthUserId,
  findSelectableHouseholdsByUserId,
} from "@/modules/context/authenticated-context.repository";
import { getSelectedWebHouseholdId } from "@/infrastructure/auth/web-household-selection";
import { createHouseholdForAuthenticatedUser, HouseholdApplicationUserNotFoundError, HouseholdRepositoryError, HouseholdValidationError } from "@/modules/households/household.service";

export async function GET(): Promise<Response> {
  try {
    const authUser = await getAuthenticatedAuthUser();
    const user = await findApplicationUserByAuthUserId(authUser.id);
    if (!user) return Response.json({ error: { code: "APPLICATION_USER_NOT_FOUND", message: "La identidad autenticada no tiene acceso a la aplicación." } }, { status: 403 });
    const memberships = await findSelectableHouseholdsByUserId(user.id);
    const selectedHouseholdId = await getSelectedWebHouseholdId();
    return Response.json({ data: memberships.map(({ householdId, householdName }) => ({ householdId, householdName, selected: householdId === selectedHouseholdId })) });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED")
      return Response.json({ error: { code: "UNAUTHENTICATED", message: "Se requiere una sesión autenticada." } }, { status: 401 });
    if (error instanceof AuthenticatedContextRepositoryError)
      return Response.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible completar la operación." } }, { status: 500 });
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible completar la operación." } }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "name" && key !== "idempotencyKey"))
      return Response.json({ error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." } }, { status: 400 });
    const authUser = await getAuthenticatedAuthUser();
    const result = await createHouseholdForAuthenticatedUser({ authUserId: authUser.id, name: body.name, idempotencyKey: body.idempotencyKey });
    return Response.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return Response.json({ error: { code: "UNAUTHENTICATED", message: "Se requiere una sesión autenticada." } }, { status: 401 });
    if (error instanceof HouseholdApplicationUserNotFoundError) return Response.json({ error: { code: "APPLICATION_USER_NOT_FOUND", message: "La identidad autenticada no tiene acceso a la aplicación." } }, { status: 403 });
    if (error instanceof HouseholdValidationError) return Response.json({ error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." } }, { status: 400 });
    if (error instanceof HouseholdRepositoryError) return Response.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible completar la operación." } }, { status: 500 });
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible completar la operación." } }, { status: 500 });
  }
}
