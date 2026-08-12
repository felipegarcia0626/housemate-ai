import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { getExpense } from "@/modules/expenses/expense.service";
import {
  ExpenseDomainError,
  type Expense,
} from "@/modules/expenses/expense.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(
  status: number,
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(status = 422): Response {
  return errorResponse(status, "VALIDATION_ERROR", "Solicitud inválida.");
}

function publicExpense(expense: Expense) {
  return {
    id: expense.id,
    createdBy: expense.createdBy,
    paidByMemberId: expense.paidByMemberId,
    merchant: expense.merchant,
    description: expense.description,
    totalAmount: expense.totalAmount,
    expenseDate: expense.expenseDate,
    status: expense.status,
    category: expense.category,
    items: expense.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalAmount,
      category: item.category,
    })),
    splits: expense.distributions.map((distribution) => ({
      memberId: distribution.householdMemberId,
      percentage: distribution.percentage,
      amount: distribution.amount,
    })),
  };
}

function hasQueryParameters(request: Request): boolean {
  return new URL(request.url).search.length > 1;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (hasQueryParameters(request)) {
    return invalidRequest(400);
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return invalidRequest();
  }

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const expense = await getExpense({ householdId }, id);
    return Response.json({ data: publicExpense(expense) });
  } catch (error) {
    if (error instanceof ExpenseDomainError) {
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
