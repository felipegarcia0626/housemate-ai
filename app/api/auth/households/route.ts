import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import {
  AuthenticatedContextRepositoryError,
  findApplicationUserByAuthUserId,
  findSelectableHouseholdsByUserId,
} from "@/modules/context/authenticated-context.repository";
import { getSelectedWebHouseholdId } from "@/infrastructure/auth/web-household-selection";

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
