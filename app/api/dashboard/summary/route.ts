import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { getDashboard } from "@/modules/dashboard/dashboard.service";
import {
  DashboardDomainError,
  type DashboardFilters,
} from "@/modules/dashboard/dashboard.types";

const ALLOWED_QUERY_PARAMETERS = new Set(["from", "to"]);

function errorResponse(
  status: 422 | 500,
  code: "VALIDATION_ERROR" | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(): Response {
  return errorResponse(422, "VALIDATION_ERROR", "Solicitud inválida.");
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
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const result = await getDashboard(
      { householdId },
      buildFilters(searchParams),
    );
    return Response.json({ data: result });
  } catch (error) {
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
