import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type { Category } from "./category.types";

interface CategoryRow {
  id: string;
  name: string;
}

interface CategoryValidationRow {
  id: string;
  movement_type: string | null;
  level: string | null;
  parent_id: string | null;
  is_active: boolean;
}

interface CategoryParentRow {
  id: string;
  movement_type: string | null;
  level: string | null;
}

export type CategoryMovementType = "EXPENSE" | "INCOME";

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

export async function getAvailableCategoryIds(
  categoryIds: readonly string[],
  movementType: CategoryMovementType,
): Promise<Set<string>> {
  const uniqueIds = [...new Set(categoryIds)];

  if (uniqueIds.length === 0) {
    return new Set();
  }

  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id,movement_type,level,parent_id,is_active")
    .in("id", uniqueIds);

  if (error) {
    throw new CategoryRepositoryError(error);
  }

  const rows = (data ?? []) as CategoryValidationRow[];
  const parentIds = [
    ...new Set(
      rows
        .filter((row) => row.parent_id !== null)
        .map((row) => row.parent_id as string),
    ),
  ];
  const parents = new Map<string, CategoryParentRow>();

  if (parentIds.length > 0) {
    const { data: parentData, error: parentError } = await getSupabaseAdminClient()
      .from("tb_categories")
      .select("id,movement_type,level")
      .in("id", parentIds);

    if (parentError) {
      throw new CategoryRepositoryError(parentError);
    }

    for (const parent of (parentData ?? []) as CategoryParentRow[]) {
      parents.set(parent.id.toLowerCase(), parent);
    }
  }

  return new Set(
    rows
      .filter((row) => {
        if (
          row.movement_type !== movementType ||
          row.level !== "MICRO" ||
          row.is_active !== true ||
          row.parent_id === null
        ) {
          return false;
        }

        const parent = parents.get(row.parent_id.toLowerCase());
        return (
          parent?.movement_type === movementType && parent.level === "MACRO"
        );
      })
      .map((row) => row.id.toLowerCase()),
  );
}
