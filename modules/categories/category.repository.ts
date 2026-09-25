import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import { normalizeCategoryName } from "./category.types";
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
  readonly code:
    | "PERSISTENCE"
    | "INVALID_NAME"
    | "PARENT_NOT_FOUND"
    | "PARENT_INVALID"
    | "PARENT_INACTIVE"
    | "INACTIVE_CONFLICT";

  constructor(
    cause: unknown,
    code:
      | "PERSISTENCE"
      | "INVALID_NAME"
      | "PARENT_NOT_FOUND"
      | "PARENT_INVALID"
      | "PARENT_INACTIVE"
      | "INACTIVE_CONFLICT" = "PERSISTENCE",
  ) {
    super("Unable to access Categories.", { cause });
    this.name = "CategoryRepositoryError";
    this.code = code;
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

interface CategoryCreationRow {
  id: string;
  name: string;
  movement_type: CategoryMovementType;
  level: "MACRO" | "MICRO";
  parent_id: string | null;
  is_active: boolean;
}

function deterministicCategoryId(
  movementType: CategoryMovementType,
  parentMacroId: string,
  normalizedName: string,
): string {
  const bytes = createHash("sha256")
    .update(`${movementType}:${parentMacroId}:${normalizedName}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toHierarchicalCategory(
  row: CategoryCreationRow,
  macroName: string,
): HierarchicalCategory {
  return {
    id: row.id,
    name: row.name,
    movementType: row.movement_type,
    level: "MICRO",
    parentId: row.parent_id as string,
    isActive: true,
    macroId: row.parent_id as string,
    macroName,
    path: `${macroName} → ${row.name}`,
  };
}

async function findMatchingMicro(
  movementType: CategoryMovementType,
  parentMacroId: string,
  normalizedName: string,
): Promise<CategoryCreationRow | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_categories")
    .select("id,name,movement_type,level,parent_id,is_active")
    .eq("movement_type", movementType)
    .eq("level", "MICRO")
    .eq("parent_id", parentMacroId);

  if (error) throw new CategoryRepositoryError(error);
  const row = ((data ?? []) as CategoryCreationRow[]).find(
    (candidate) => normalizeCategoryName(candidate.name) === normalizedName,
  );
  return row ?? null;
}

export async function createOrReuseMicroCategory(input: {
  name: string;
  movementType: CategoryMovementType;
  parentMacroId: string;
}): Promise<HierarchicalCategory> {
  const name = input.name.trim();
  const normalizedName = normalizeCategoryName(name);
  if (!normalizedName) {
    throw new CategoryRepositoryError(null, "INVALID_NAME");
  }

  const client = getSupabaseAdminClient();
  const { data: parentData, error: parentError } = await client
    .from("tb_categories")
    .select("id,name,movement_type,level,is_active")
    .eq("id", input.parentMacroId)
    .maybeSingle();

  if (parentError) throw new CategoryRepositoryError(parentError);
  if (!parentData) {
    throw new CategoryRepositoryError(null, "PARENT_NOT_FOUND");
  }
  if (
    parentData.level !== "MACRO" ||
    parentData.movement_type !== input.movementType
  ) {
    throw new CategoryRepositoryError(null, "PARENT_INVALID");
  }
  if (parentData.is_active !== true) {
    throw new CategoryRepositoryError(null, "PARENT_INACTIVE");
  }

  const existing = await findMatchingMicro(
    input.movementType,
    input.parentMacroId,
    normalizedName,
  );
  if (existing) {
    if (!existing.is_active) {
      throw new CategoryRepositoryError(null, "INACTIVE_CONFLICT");
    }
    return toHierarchicalCategory(existing, parentData.name);
  }

  const id = deterministicCategoryId(
    input.movementType,
    input.parentMacroId,
    normalizedName,
  );
  const { data, error } = await client
    .from("tb_categories")
    .insert({
      id,
      movement_type: input.movementType,
      level: "MICRO",
      parent_id: input.parentMacroId,
      name,
      description: null,
      is_active: true,
    })
    .select("id,name,movement_type,level,parent_id,is_active")
    .single();

  if (!error && data) {
    return toHierarchicalCategory(data as CategoryCreationRow, parentData.name);
  }

  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (errorCode === "23505") {
    const concurrent = await findMatchingMicro(
      input.movementType,
      input.parentMacroId,
      normalizedName,
    );
    if (concurrent) {
      if (!concurrent.is_active) {
        throw new CategoryRepositoryError(null, "INACTIVE_CONFLICT");
      }
      return toHierarchicalCategory(concurrent, parentData.name);
    }
  }
  throw new CategoryRepositoryError(error);
}
