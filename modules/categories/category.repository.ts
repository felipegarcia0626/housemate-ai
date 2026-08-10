import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type { Category } from "./category.types";

interface CategoryRow {
  id: string;
  name: string;
}

export class CategoryRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to access Categories.", { cause });
    this.name = "CategoryRepositoryError";
  }
}

export async function listCategories(): Promise<Category[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id,name");

  if (error) {
    throw new CategoryRepositoryError(error);
  }

  return ((data ?? []) as CategoryRow[]).map((row) => ({
    id: row.id,
    name: row.name,
  }));
}
