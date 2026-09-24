import { listHierarchicalCategories } from "@/modules/categories/category.service";
import type { CategoryMovementType } from "@/modules/categories/category.types";

function errorResponse(
  status: 400 | 422 | 500,
  code: "VALIDATION_ERROR" | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidRequest(status: 400 | 422): Response {
  return errorResponse(status, "VALIDATION_ERROR", "Solicitud inválida.");
}

function isCategoryMovementType(
  value: string | null,
): value is CategoryMovementType {
  return value === "EXPENSE" || value === "INCOME";
}

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const parameterNames = [...new Set(searchParams.keys())];

  if (
    parameterNames.some((name) => name !== "movementType") ||
    searchParams.getAll("movementType").length !== 1
  ) {
    return invalidRequest(400);
  }

  const movementType = searchParams.get("movementType");
  if (!isCategoryMovementType(movementType)) {
    return invalidRequest(422);
  }

  try {
    const categories = await listHierarchicalCategories(movementType);
    return Response.json({ data: categories });
  } catch {
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}
