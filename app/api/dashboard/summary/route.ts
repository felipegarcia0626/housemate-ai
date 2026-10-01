import { getDashboard } from "@/modules/dashboard/dashboard.service";
import { resolveAuthenticatedContext } from "@/modules/context/authenticated-context.service";
import { AuthenticatedContextError } from "@/modules/context/authenticated-context.types";
import {
  DashboardDomainError,
  type DashboardFilters,
} from "@/modules/dashboard/dashboard.types";

const ALLOWED_QUERY_PARAMETERS = new Set(["from", "to"]);

function errorResponse(
  status: 401 | 403 | 409 | 422 | 500,
  code:
    | "UNAUTHENTICATED"
    | "APPLICATION_USER_NOT_FOUND"
    | "NO_ACTIVE_MEMBERSHIP"
    | "HOUSEHOLD_SELECTION_REQUIRED"
    | "VALIDATION_ERROR"
    | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(): Response {
  return errorResponse(422, "VALIDATION_ERROR", "Solicitud inválida.");
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

function hasUnsupportedOrRepeatedParameters(
  searchParams: URLSearchParams,
): boolean {
  for (const name of new Set(searchParams.keys())) {
    if (
      !ALLOWED_QUERY_PARAMETERS.has(name) ||
      searchParams.getAll(name).length !== 1
    ) {
      return true;
    }
  }
  return false;
}

function buildFilters(searchParams: URLSearchParams): DashboardFilters {
  const filters: DashboardFilters = {};
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from !== null) filters.from = from;
  if (to !== null) filters.to = to;
  return filters;
}

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  if (hasUnsupportedOrRepeatedParameters(searchParams)) {
    return invalidRequest();
  }

  try {
    const context = await resolveAuthenticatedContext();
    const result = await getDashboard(
      { householdId: context.householdId },
      buildFilters(searchParams),
    );
    return Response.json({ data: result });
  } catch (error) {
    if (error instanceof AuthenticatedContextError) {
      return contextErrorResponse(error);
    }
    if (error instanceof DashboardDomainError) {
      if (error.code === "VALIDATION_ERROR") return invalidRequest();
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}
