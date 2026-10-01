import { resolveAuthenticatedContext } from "@/modules/context/authenticated-context.service";
import { AuthenticatedContextError } from "@/modules/context/authenticated-context.types";
import { getBalance } from "@/modules/expenses/balance.service";

function errorResponse(
  status: 401 | 403 | 409 | 500,
  code:
    | "UNAUTHENTICATED"
    | "APPLICATION_USER_NOT_FOUND"
    | "NO_ACTIVE_MEMBERSHIP"
    | "HOUSEHOLD_SELECTION_REQUIRED"
    | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function contextErrorResponse(error: AuthenticatedContextError): Response {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return errorResponse(
        401,
        "UNAUTHENTICATED",
        "Se requiere una sesión autenticada.",
      );
    case "APPLICATION_USER_NOT_FOUND":
      return errorResponse(
        403,
        "APPLICATION_USER_NOT_FOUND",
        "La identidad autenticada no tiene acceso a la aplicación.",
      );
    case "NO_ACTIVE_MEMBERSHIP":
      return errorResponse(
        403,
        "NO_ACTIVE_MEMBERSHIP",
        "La identidad autenticada no tiene un hogar activo.",
      );
    case "HOUSEHOLD_SELECTION_REQUIRED":
      return errorResponse(
        409,
        "HOUSEHOLD_SELECTION_REQUIRED",
        "Debes seleccionar un hogar antes de continuar.",
      );
    default:
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "No fue posible completar la operación.",
      );
  }
}

export async function GET(): Promise<Response> {
  try {
    const context = await resolveAuthenticatedContext();
    const result = await getBalance({ householdId: context.householdId });
    return Response.json({ data: result });
  } catch (error) {
    if (error instanceof AuthenticatedContextError) {
      return contextErrorResponse(error);
    }
    return Response.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "No fue posible completar la operación.",
        },
      },
      { status: 500 },
    );
  }
}
