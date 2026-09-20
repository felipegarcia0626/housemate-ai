import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type {
  Category,
  CategoryMovementType,
  HierarchicalCategory,
} from "./category.types";

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

interface HierarchicalCategoryRow extends CategoryValidationRow {
  name: string;
}

interface CategoryMacroRow {
  id: string;
  name: string;
  movement_type: string | null;
  level: string | null;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function listHierarchicalCategories(
  movementType: CategoryMovementType,
): Promise<HierarchicalCategory[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id,name,movement_type,level,parent_id,is_active")
    .eq("movement_type", movementType)
    .eq("level", "MICRO")
    .eq("is_active", true)
    .order("parent_id", { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    throw new CategoryRepositoryError(error);
  }

  const rows = (data ?? []) as HierarchicalCategoryRow[];
  const parentIds = [
    ...new Set(
      rows
        .filter((row) => row.parent_id !== null)
        .map((row) => row.parent_id as string),
    ),
  ];

  if (parentIds.length === 0) {
    return [];
  }

  const { data: parentData, error: parentError } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id,name,movement_type,level")
    .in("id", parentIds)
    .eq("movement_type", movementType)
    .eq("level", "MACRO");

  if (parentError) {
    throw new CategoryRepositoryError(parentError);
  }

  const parents = new Map<string, CategoryMacroRow>();
  for (const parent of (parentData ?? []) as CategoryMacroRow[]) {
    parents.set(parent.id.toLowerCase(), parent);
  }

  return rows
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
    .map((row) => {
      const parent = parents.get(row.parent_id!.toLowerCase())!;
      return {
        id: row.id,
        name: row.name,
        movementType,
        level: "MICRO",
        parentId: parent.id,
        isActive: true,
        macroId: parent.id,
        macroName: parent.name,
        path: `${parent.name} → ${row.name}`,
      } satisfies HierarchicalCategory;
    })
    .sort(
      (left, right) =>
        compareText(left.macroName, right.macroName) ||
        compareText(left.name, right.name) ||
        compareText(left.id, right.id),
    );
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
