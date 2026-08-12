import {
  getConfiguredHttpActorContext,
  getConfiguredHttpHouseholdContext,
} from "@/app/api/_lib/http-context";
import {
  createExpense,
  listExpenses,
} from "@/modules/expenses/expense.service";
import {
  ExpenseCreatedNotHydratedError,
  ExpenseDomainError,
  type Expense,
  type ExpenseCreateInput,
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

const CREATE_FIELDS = new Set([
  "merchant",
  "description",
  "totalAmount",
  "expenseDate",
  "paidByMemberId",
  "categoryId",
  "receiptId",
  "items",
  "splits",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error("unsupported field");
  }
}

function parseCreateInput(
  body: unknown,
  createdBy: string,
): ExpenseCreateInput {
  if (!isRecord(body)) {
    throw new Error("body must be an object");
  }

  assertAllowedFields(body, CREATE_FIELDS);

  for (const field of [
    "totalAmount",
    "expenseDate",
    "paidByMemberId",
    "splits",
  ]) {
    if (!Object.hasOwn(body, field)) {
      throw new Error("missing required field");
    }
  }

  const items = body.items;
  if (items !== undefined) {
    if (!Array.isArray(items)) {
      throw new Error("items must be an array");
    }

    for (const item of items) {
      if (!isRecord(item)) {
        throw new Error("item must be an object");
      }
      assertAllowedFields(
        item,
        new Set(["name", "quantity", "unitPrice", "totalPrice", "categoryId"]),
      );
      if (!Object.hasOwn(item, "name") || !Object.hasOwn(item, "totalPrice")) {
        throw new Error("item fields are incomplete");
      }
    }
  }

  if (!Array.isArray(body.splits)) {
    throw new Error("splits must be an array");
  }

  for (const split of body.splits) {
    if (!isRecord(split)) {
      throw new Error("split must be an object");
    }
    assertAllowedFields(split, new Set(["memberId", "percentage"]));
    if (
      !Object.hasOwn(split, "memberId") ||
      !Object.hasOwn(split, "percentage")
    ) {
      throw new Error("split fields are incomplete");
    }
  }

  return {
    createdBy,
    paidByMemberId: body.paidByMemberId as string,
    categoryId: (body.categoryId as string | null | undefined) ?? null,
    receiptId: (body.receiptId as string | null | undefined) ?? null,
    merchant: (body.merchant as string | null | undefined) ?? null,
    totalAmount: body.totalAmount as number,
    expenseDate: body.expenseDate as string,
    description: (body.description as string | null | undefined) ?? null,
    source: "WEB",
    items: (items as Array<Record<string, unknown>> | undefined)?.map(
      (item) => ({
        name: item.name as string,
        quantity: (item.quantity as number | null | undefined) ?? null,
        unitPrice: (item.unitPrice as number | null | undefined) ?? null,
        totalAmount: item.totalPrice as number,
        categoryId: (item.categoryId as string | null | undefined) ?? null,
      }),
    ),
    splits: (body.splits as Array<Record<string, unknown>>).map((split) => ({
      householdMemberId: split.memberId as string,
      percentage: split.percentage as number,
    })),
  };
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

function invalidJson(): Response {
  return invalidRequest(422);
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

export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).search.length > 1) {
    return invalidRequest(400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  let householdId: string;
  let createdBy: string;

  try {
    ({ householdId } = await getConfiguredHttpHouseholdContext());
    ({ memberId: createdBy } = await getConfiguredHttpActorContext());
    const input = parseCreateInput(body, createdBy);
    const expense = await createExpense({ householdId }, input);

    return Response.json({ data: publicExpense(expense) }, { status: 201 });
  } catch (error) {
    const possibleExpenseId =
      typeof error === "object" && error !== null && "expenseId" in error
        ? (error as { expenseId?: unknown }).expenseId
        : undefined;
    if (
      (error instanceof ExpenseCreatedNotHydratedError ||
        (error instanceof ExpenseDomainError &&
          error.code === "CREATED_NOT_HYDRATED")) &&
      typeof possibleExpenseId === "string"
    ) {
      return Response.json(
        {
          error: {
            code: "CREATED_NOT_HYDRATED",
            message: "El Expense fue creado pero no pudo cargarse.",
            expenseId: possibleExpenseId,
          },
        },
        { status: 202 },
      );
    }

    if (error instanceof ExpenseDomainError) {
      if (error.code === "VALIDATION_ERROR") return invalidRequest(422);
      if (error.code === "NOT_FOUND" || error.code === "HOUSEHOLD_MISMATCH") {
        return errorResponse(404, "NOT_FOUND", "Recurso no encontrado.");
      }
    }

    if (error instanceof Error && error.message === "unsupported field") {
      return invalidRequest(400);
    }

    if (
      error instanceof Error &&
      /missing|must be|incomplete|object|array/.test(error.message)
    ) {
      return invalidRequest(422);
    }

    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}
