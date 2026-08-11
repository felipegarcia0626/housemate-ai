import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { listExpenses } from "@/modules/expenses/expense.service";
import {
  ExpenseDomainError,
  type ExpenseReadFilters,
} from "@/modules/expenses/expense.types";

const ALLOWED_QUERY_PARAMETERS = new Set([
  "from",
  "to",
  "categoryId",
  "memberId",
  "merchant",
  "minAmount",
  "maxAmount",
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

function buildFilters(searchParams: URLSearchParams): ExpenseReadFilters {
  const filters: ExpenseReadFilters = {};

  const stringFilters = [
    "from",
    "to",
    "categoryId",
    "memberId",
    "merchant",
  ] as const;

  for (const name of stringFilters) {
    const value = searchParams.get(name);

    if (value !== null) {
      filters[name] = value;
    }
  }

  const minAmount = searchParams.get("minAmount");
  const maxAmount = searchParams.get("maxAmount");

  if (minAmount !== null) {
    filters.minAmount = Number(minAmount);
  }
  if (maxAmount !== null) {
    filters.maxAmount = Number(maxAmount);
  }

  return filters;
}

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;

  if (hasUnsupportedOrRepeatedParameters(searchParams)) {
    return invalidRequest(400);
  }

  if (
    searchParams.get("minAmount") === "" ||
    searchParams.get("maxAmount") === ""
  ) {
    return invalidRequest(422);
  }

  const filters = buildFilters(searchParams);

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const expenses = await listExpenses({ householdId }, filters);

    return Response.json({ data: expenses });
  } catch (error) {
    if (error instanceof ExpenseDomainError) {
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
