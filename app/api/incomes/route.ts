import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { listIncomes } from "@/modules/incomes/income.service";
import {
  IncomeDomainError,
  type IncomeListFilters,
} from "@/modules/incomes/income.types";

const ALLOWED_QUERY_PARAMETERS = new Set([
  "from",
  "to",
  "memberId",
  "categoryId",
]);

function errorResponse(
  status: number,
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(status: 400 | 422): Response {
  return errorResponse(status, "VALIDATION_ERROR", "Solicitud inválida.");
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

function buildFilters(searchParams: URLSearchParams): IncomeListFilters {
  const filters: IncomeListFilters = {};
  const filterNames = ["from", "to", "memberId", "categoryId"] as const;

  for (const name of filterNames) {
    const value = searchParams.get(name);

    if (value !== null) {
      filters[name] = value;
    }
  }

  return filters;
}

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;

  if (hasUnsupportedOrRepeatedParameters(searchParams)) {
    return invalidRequest(400);
  }

  const filters = buildFilters(searchParams);

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const result = await listIncomes({ householdId }, filters);
    const data = result.incomes.map((income) => ({
      id: income.id,
      createdBy: income.createdBy,
      memberId: income.memberId,
      amount: income.amount,
      incomeDate: income.incomeDate,
      description: income.description,
      categoryId: income.categoryId,
    }));

    return Response.json({ data, summary: result.summary });
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      if (error.code === "VALIDATION_ERROR") {
        return invalidRequest(422);
      }
      if (error.code === "NOT_FOUND" || error.code === "HOUSEHOLD_MISMATCH") {
        return errorResponse(404, "NOT_FOUND", "Recurso no encontrado.");
      }
    }

    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}
