import {
  getConfiguredHttpActorContext,
  getConfiguredHttpHouseholdContext,
} from "@/app/api/_lib/http-context";
import { resolveAuthenticatedContext } from "@/modules/context/authenticated-context.service";
import { AuthenticatedContextError } from "@/modules/context/authenticated-context.types";
import { createIncome, listIncomes } from "@/modules/incomes/income.service";
import {
  IncomeDomainError,
  type Income,
  type IncomeCreateInput,
  type IncomeListFilters,
} from "@/modules/incomes/income.types";

const ALLOWED_QUERY_PARAMETERS = new Set([
  "from",
  "to",
  "memberId",
  "categoryId",
  "macroId",
  "search",
  "minAmount",
  "maxAmount",
  "page",
  "pageSize",
  "sortBy",
  "sortOrder",
]);

function errorResponse(
  status: number,
  code:
    | "VALIDATION_ERROR"
    | "NOT_FOUND"
    | "INTERNAL_ERROR"
    | "UNAUTHENTICATED"
    | "APPLICATION_USER_NOT_FOUND"
    | "NO_ACTIVE_MEMBERSHIP"
    | "HOUSEHOLD_SELECTION_REQUIRED",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(status: 400 | 422): Response {
  return errorResponse(status, "VALIDATION_ERROR", "Solicitud inválida.");
}

function contextErrorResponse(error: AuthenticatedContextError): Response {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return errorResponse(401, "UNAUTHENTICATED", "Se requiere una sesión autenticada.");
    case "APPLICATION_USER_NOT_FOUND":
      return errorResponse(403, "APPLICATION_USER_NOT_FOUND", "La identidad autenticada no tiene acceso a la aplicación.");
    case "NO_ACTIVE_MEMBERSHIP":
      return errorResponse(403, "NO_ACTIVE_MEMBERSHIP", "La identidad autenticada no tiene un hogar activo.");
    case "HOUSEHOLD_SELECTION_REQUIRED":
      return errorResponse(409, "HOUSEHOLD_SELECTION_REQUIRED", "Debes seleccionar un hogar antes de continuar.");
    default:
      return errorResponse(500, "INTERNAL_ERROR", "No fue posible completar la operación.");
  }
}

function publicIncome(income: Income) {
  return {
    id: income.id,
    createdBy: income.createdBy,
    memberId: income.memberId,
    amount: income.amount,
    incomeDate: income.incomeDate,
    description: income.description,
    categoryId: income.categoryId,
  };
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
  const filterNames = [
    "from",
    "to",
    "memberId",
    "categoryId",
    "macroId",
    "search",
  ] as const;

  for (const name of filterNames) {
    const value = searchParams.get(name);

    if (value !== null) {
      filters[name] = value;
    }
  }

  const page = searchParams.get("page");
  const pageSize = searchParams.get("pageSize");
  const minAmount = searchParams.get("minAmount");
  const maxAmount = searchParams.get("maxAmount");
  const sortBy = searchParams.get("sortBy");
  const sortOrder = searchParams.get("sortOrder");

  if (page !== null) filters.page = Number(page);
  if (pageSize !== null) filters.pageSize = Number(pageSize) as 25 | 50 | 100;
  if (minAmount !== null) filters.minAmount = Number(minAmount);
  if (maxAmount !== null) filters.maxAmount = Number(maxAmount);
  if (sortBy !== null) {
    filters.sortBy = sortBy as "incomeDate" | "amount" | "description";
  }
  if (sortOrder !== null) filters.sortOrder = sortOrder as "asc" | "desc";

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
    const context = await resolveAuthenticatedContext();
    const result = await listIncomes({ householdId: context.householdId }, filters);
    const data = result.incomes.map((income) => ({
      id: income.id,
      createdBy: income.createdBy,
      memberId: income.memberId,
      amount: income.amount,
      incomeDate: income.incomeDate,
      description: income.description,
      categoryId: income.categoryId,
    }));

    return Response.json({
      data,
      pagination: result.pagination,
      summary: result.summary,
    });
  } catch (error) {
    if (error instanceof AuthenticatedContextError) {
      return contextErrorResponse(error);
    }
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

export async function POST(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  if ([...searchParams.keys()].length > 0) {
    return invalidRequest(400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest(422);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalidRequest(422);
  }

  const allowed = new Set([
    "memberId",
    "amount",
    "incomeDate",
    "description",
    "categoryId",
  ]);
  const candidate = body as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => !allowed.has(key))) {
    return invalidRequest(400);
  }

  const input: IncomeCreateInput = {
    memberId: candidate.memberId as string,
    amount: candidate.amount as number,
    incomeDate: candidate.incomeDate as string,
    description: candidate.description as string,
    categoryId: candidate.categoryId as string | null | undefined,
  };

  try {
    const context = await resolveAuthenticatedContext();

    const income = await createIncome(
      { householdId: context.householdId, memberId: context.memberId },
      input,
    );
    return Response.json({ data: publicIncome(income) }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticatedContextError) {
      return contextErrorResponse(error);
    }
    if (error instanceof IncomeDomainError) {
      if (error.code === "VALIDATION_ERROR") return invalidRequest(422);
      if (error.code === "NOT_FOUND" || error.code === "HOUSEHOLD_MISMATCH") {
        return errorResponse(404, "NOT_FOUND", "Recurso no encontrado.");
      }
    }

    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operaciÃ³n.",
    );
  }
}
