import {
  getConfiguredHttpActorContext,
  getConfiguredHttpHouseholdContext,
} from "@/app/api/_lib/http-context";
import { updateExpense, getExpense } from "@/modules/expenses/expense.service";
import {
  ExpenseDomainError,
  type Expense,
  type ExpenseUpdateInput,
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

const UPDATE_FIELDS = new Set([
  "merchant",
  "description",
  "totalAmount",
  "expenseDate",
  "paidByMemberId",
  "categoryId",
  "items",
  "splits",
]);

function parseUpdateInput(body: unknown): ExpenseUpdateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("invalid body");
  }
  const candidate = body as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => !UPDATE_FIELDS.has(key))) {
    throw new Error("unsupported field");
  }

  const input: ExpenseUpdateInput = {};
  if (Object.hasOwn(candidate, "merchant"))
    input.merchant = candidate.merchant as string | null;
  if (Object.hasOwn(candidate, "description"))
    input.description = candidate.description as string | null;
  if (Object.hasOwn(candidate, "totalAmount"))
    input.totalAmount = candidate.totalAmount as number;
  if (Object.hasOwn(candidate, "expenseDate"))
    input.expenseDate = candidate.expenseDate as string;
  if (Object.hasOwn(candidate, "paidByMemberId"))
    input.paidByMemberId = candidate.paidByMemberId as string;
  if (Object.hasOwn(candidate, "categoryId"))
    input.categoryId = candidate.categoryId as string | null;
  if (Object.hasOwn(candidate, "items")) {
    if (!Array.isArray(candidate.items)) throw new Error("invalid body");
    input.items = candidate.items.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("invalid body");
      }
      const value = item as Record<string, unknown>;
      const allowed = new Set([
        "name",
        "quantity",
        "unitPrice",
        "totalPrice",
        "categoryId",
      ]);
      if (
        Object.keys(value).some((key) => !allowed.has(key)) ||
        !Object.hasOwn(value, "name") ||
        !Object.hasOwn(value, "totalPrice")
      ) {
        throw new Error("invalid body");
      }
      return {
        name: value.name as string,
        quantity: (value.quantity as number | null | undefined) ?? null,
        unitPrice: (value.unitPrice as number | null | undefined) ?? null,
        totalAmount: value.totalPrice as number,
        categoryId: (value.categoryId as string | null | undefined) ?? null,
      };
    });
  }
  if (Object.hasOwn(candidate, "splits")) {
    if (!Array.isArray(candidate.splits)) throw new Error("invalid body");
    input.splits = candidate.splits.map((split) => {
      if (typeof split !== "object" || split === null || Array.isArray(split)) {
        throw new Error("invalid body");
      }
      const value = split as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (key) => !new Set(["memberId", "percentage"]).has(key),
        ) ||
        !Object.hasOwn(value, "memberId") ||
        !Object.hasOwn(value, "percentage")
      ) {
        throw new Error("invalid body");
      }
      return {
        householdMemberId: value.memberId as string,
        percentage: value.percentage as number,
      };
    });
  }
  return input;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (new URL(request.url).search.length > 1) return invalidRequest(400);

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return invalidRequest();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }

  let input: ExpenseUpdateInput;
  try {
    input = parseUpdateInput(body);
  } catch (error) {
    return error instanceof Error && error.message === "unsupported field"
      ? invalidRequest(400)
      : invalidRequest();
  }

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const actorContext = await getConfiguredHttpActorContext();
    if (actorContext.householdId !== householdId) {
      return errorResponse(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    const expense = await updateExpense({ householdId }, id, input);
    return Response.json({ data: publicExpense(expense) });
  } catch (error) {
    const possibleExpenseId =
      typeof error === "object" && error !== null && "expenseId" in error
        ? (error as { expenseId?: unknown }).expenseId
        : undefined;
    if (
      error instanceof ExpenseDomainError &&
      error.code === "UPDATED_NOT_HYDRATED" &&
      typeof possibleExpenseId === "string"
    ) {
      return Response.json(
        {
          error: {
            code: "UPDATED_NOT_HYDRATED",
            message: "El Expense fue actualizado pero no pudo cargarse.",
            expenseId: possibleExpenseId,
          },
        },
        { status: 202 },
      );
    }
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
