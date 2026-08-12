import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { deleteIncome, updateIncome } from "@/modules/incomes/income.service";
import {
  IncomeDomainError,
  type IncomeUpdateInput,
} from "@/modules/incomes/income.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(
  status: number,
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(status: 400 | 422 = 422): Response {
  return errorResponse(status, "VALIDATION_ERROR", "Solicitud inválida.");
}

function publicIncome(income: Awaited<ReturnType<typeof updateIncome>>) {
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalidRequest();
  }

  const allowed = new Set([
    "memberId",
    "amount",
    "incomeDate",
    "description",
    "categoryId",
  ]);
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    return invalidRequest();
  }

  const input: IncomeUpdateInput = {};
  const candidate = body as Record<string, unknown>;
  if ("memberId" in candidate) input.memberId = candidate.memberId as string;
  if ("amount" in candidate) input.amount = candidate.amount as number;
  if ("incomeDate" in candidate)
    input.incomeDate = candidate.incomeDate as string;
  if ("description" in candidate)
    input.description = candidate.description as string;
  if ("categoryId" in candidate)
    input.categoryId = candidate.categoryId as string | null;

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const { id } = await params;
    const income = await updateIncome({ householdId }, id, input);
    return Response.json({ data: publicIncome(income) });
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      if (error.code === "VALIDATION_ERROR") return invalidRequest();
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (new URL(request.url).search.length > 1) return invalidRequest(400);

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return invalidRequest();

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    await deleteIncome({ householdId }, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof IncomeDomainError) {
      if (error.code === "VALIDATION_ERROR") return invalidRequest();
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
