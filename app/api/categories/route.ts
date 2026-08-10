import { listCategories } from "@/modules/categories/category.service";

export async function GET(): Promise<Response> {
  try {
    const categories = await listCategories();

    return Response.json({ data: categories });
  } catch {
    return Response.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "No fue posible completar la operación.",
        },
      },
      { status: 500 },
    );
  }
}
